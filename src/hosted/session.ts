/**
 * Session management for the hosted conformance server.
 *
 * A "cell" is one scenario exercised at one specification revision inside a
 * run. Its id, `<run-id>/<revision>/<scenario>`, is at once the URL path the
 * client is pointed at, the store key and the results path. Each cell owns a
 * fresh Scenario instance built for that revision's wire and the
 * RequestListener it returns from handler() — no loopback port, no proxy.
 * Cells are created lazily on first reference and can be rebuilt from their
 * id alone, which is what lets a cold serverless isolate answer for a run it
 * never saw (an aux-origin request arriving before the RS was ever hit, say).
 */

import { randomBytes } from 'crypto';
import {
  Scenario,
  ConformanceCheck,
  RequestListener,
  AuthHandlerScenario,
  AuxOriginRole,
  SpecVersion,
  isSpecVersion
} from '../types';
import type {
  MockHandler,
  RequestHandlers,
  ScenarioContext
} from '../mock-server';
import { isStatefulVersion } from '../connection/versions';
import { hostedScenarios } from './catalog';
import {
  MemoryRunStore,
  attemptOfWriter,
  attemptWriter,
  type RunStore
} from './store';
import {
  addExchange,
  addIssued,
  emptyRow,
  mergeRows,
  substance,
  type Exchange,
  type TrafficRow
} from './traffic';
import { missingRelaysReason, NOT_HOSTED_REASON } from './matrix';
import {
  addProtocolVersion,
  atCellRevision,
  identityCheck,
  identityChecksIn,
  identityKey,
  identityOf,
  IDENTITY_CHECK_ID,
  type IdentityObservation
} from './identity';
import {
  ACTIVITY_CHECK_ID,
  activityCheck,
  AUTH_STOP_CHECK_ID,
  REVISION_REACHED_CHECK_ID,
  REVISION_SPOKEN_CHECK_ID,
  revisionNotSpokenCheck,
  signedInAuthStop
} from './wire';

/**
 * Store writer suffix for the hosted layer's own checks (client identity,
 * probe notes, …). Their row belongs to one build of a cell in one process
 * (HostedRun.hostedWriter), not to the process.
 */
const HOSTED_WRITER_SUFFIX = '/hosted';

/**
 * Run ids are one path segment: safe in URLs and after the relay's /r/.
 * Any such id is accepted (pick your own, or keep an older minted one);
 * mintRunId() only draws from the unambiguous alphabet below.
 */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Crockford's base32 alphabet in lower case: no i, l, o or u, so an id read
 * off a monospace breadcrumb or a screenshot can't be misread (O vs 0).
 */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A random id of `length` characters from ID_ALPHABET (5 bits each). */
export function mintId(length: number): string {
  let id = '';
  for (const byte of randomBytes(length)) id += ID_ALPHABET[byte & 31];
  return id;
}

export function mintRunId(): string {
  return mintId(10);
}

/** One scenario at one revision inside one run. */
export interface CellRef {
  runId: string;
  revision: SpecVersion;
  scenarioName: string;
}

/** `<run-id>/<revision>/<scenario>` — scenario names may contain '/'. */
export function cellId(ref: CellRef): string {
  return `${ref.runId}/${ref.revision}/${ref.scenarioName}`;
}

export function parseCellId(id: string): CellRef | undefined {
  const [runId, revision, ...rest] = id.split('/');
  if (!RUN_ID_RE.test(runId ?? '') || !isSpecVersion(revision) || !rest.length)
    return undefined;
  return { runId, revision, scenarioName: rest.join('/') };
}

/**
 * Per-cell context for a hosted scenario: the column's revision is the wire
 * the mock speaks, exactly as `--spec-version` sets it for the CLI runner
 * (src/runner/client.ts). `createServer()` would bind a loopback port, which
 * serverless hosts don't allow — hosted scenarios use `createHandler()`.
 */
export function hostedScenarioContext(
  specVersion: SpecVersion
): ScenarioContext {
  return {
    specVersion,
    createServer: () =>
      Promise.reject(
        new Error(
          'ScenarioContext.createServer() binds a loopback port and is not available when hosted; use createHandler()'
        )
      ),
    createHandler: (handlers) => mockFactory(specVersion)(handlers, specVersion)
  };
}

type MockFactory = (
  handlers: RequestHandlers,
  specVersion: SpecVersion
) => MockHandler;

/**
 * The mock servers cells are built on, one per lifecycle, each loaded with
 * the first cell that needs it (see loadCells()): the stateful one brings the
 * SDK server, which a stateless cell never needs.
 */
const mockFactories: { stateful?: MockFactory; stateless?: MockFactory } = {};

function mockFactory(specVersion: SpecVersion): MockFactory {
  const factory = isStatefulVersion(specVersion)
    ? mockFactories.stateful
    : mockFactories.stateless;
  if (!factory) {
    throw new Error(
      `the mock server for ${specVersion} is not loaded; await loadCells() before building its cells`
    );
  }
  return factory;
}

async function loadMock(specVersion: SpecVersion): Promise<void> {
  if (isStatefulVersion(specVersion)) {
    mockFactories.stateful ??= (
      await import('../mock-server/stateful')
    ).createHandlerStateful;
  } else {
    mockFactories.stateless ??= (
      await import('../mock-server/stateless')
    ).createHandlerStateless;
  }
}

/**
 * Load what building these cells needs: each one's scenario and the mock
 * server of its revision. A request loads what it touches and nothing more,
 * so a cold process answers it without evaluating every scenario module.
 */
export async function loadCells(
  cells: Iterable<Pick<CellRef, 'scenarioName' | 'revision'>>
): Promise<void> {
  const list = Array.from(cells);
  const revisions = new Set(list.map((c) => c.revision));
  await Promise.all([
    hostedScenarios.load(list.map((c) => c.scenarioName)),
    ...Array.from(revisions, loadMock)
  ]);
}

/** loadCells() for every scenario at each of `revisions`. */
export async function loadAllCells(
  revisions: readonly SpecVersion[]
): Promise<void> {
  await Promise.all([hostedScenarios.loadAll(), ...revisions.map(loadMock)]);
}

export interface HostedRun extends CellRef {
  /** Cell id — see cellId(). */
  id: string;
  scenario: Scenario;
  /** The mounted RS handler — invoke directly with (req, res). */
  listener: RequestListener;
  /** Aux-origin handlers (AS, IdP, …) for auth scenarios. */
  auxListeners?: Partial<Record<AuxOriginRole, RequestListener>>;
  /** Sub-path under the cell URL where the MCP endpoint lives. */
  mcpPath: string;
  createdAt: number;
  lastSeenAt: number;
  /** Scenario-provided client context (credentials, steps, …). */
  context?: Record<string, unknown>;
  /** Whether the store has been told this cell exists. */
  saved: boolean;
  /**
   * Whether any request was dispatched to the cell. A cell created only to
   * answer a config request has not been exercised and stays out of the
   * results listing.
   */
  touched: boolean;
  /**
   * Checks the hosted layer records about the cell (client identity, wire
   * rejections, revision discipline), kept apart from the scenario's own log
   * so they never enter its judgement.
   */
  hostedChecks: ConformanceCheck[];
  /**
   * The store row `hostedChecks` is written to. Each build of the cell gets
   * its own, so a cell evicted and rebuilt starts a new row instead of
   * writing over what the process recorded before, and never has to read
   * the old one first; results() merges the rows as it does other
   * processes'.
   */
  hostedWriter: string;
  /** The identity check per client (name, version) already recorded. */
  identities: Map<string, ConformanceCheck>;
  /** Keys of hosted checks already recorded, so each finding is one check. */
  hostedKeys: Set<string>;
  /**
   * Checks seeded into the scenario from other processes' persisted rows
   * (see hydrate()), each with its JSON as seeded. They are those writers'
   * to persist, not ours — unless the scenario has changed one since.
   */
  seeded: Map<ConformanceCheck, string>;
  /**
   * Settled once an attempt to seed the cell from the store has finished;
   * cleared again when the store could not be read, so the next request
   * tries again.
   */
  hydration?: Promise<void>;
  /** The cell holds the run's history: seeded, or there is none to seed. */
  hydrated?: true;
  /** The last write queued for the cell; writes land one after another. */
  lastWrite?: Promise<void>;
  /** A write queued but not started yet: a persist() meanwhile joins it. */
  queuedWrite?: Promise<void>;
  /** Each of this process's rows as last written (JSON), by writer id. */
  written: Map<string, string>;
  /**
   * Which attempt at the cell this build serves: 1 until the cell is reset
   * (see SessionManager.reset()). Its checks and traffic go to rows of that
   * attempt (see attemptWriter()).
   */
  attempt: number;
  /** This build's traffic (see ./traffic.ts), written as a row of its own. */
  traffic: TrafficRow;
  /** Bytes of `traffic.exchanges` so far, for the row's cap. */
  trafficSize: { bytes: number };
  /** `traffic` as last written, without repeat counts (see substance()). */
  trafficWritten?: string;
  /**
   * Hashes of the credentials the cell issued in earlier attempts: a client
   * presenting one after a reset is treated as having none.
   */
  refused: Set<string>;
  /** Builds the cell's scenario and handlers afresh, for a new attempt. */
  build: () => CellParts;
  /** The move to a newer attempt under way, if any (see renew()). */
  renewal?: Promise<void>;
}

/** What building a cell makes: its scenario and the handlers it mounts. */
export interface CellParts {
  scenario: Scenario;
  listener: RequestListener;
  auxListeners?: Partial<Record<AuxOriginRole, RequestListener>>;
  mcpPath: string;
  context?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  /** Idle ms after which a cell is evicted from memory. Default 5 minutes. */
  ttlMs?: number;
  sweepIntervalMs?: number;
  /**
   * Public origins of the relay deployments, keyed by role. Required for any
   * scenario that exposes `authHandlers()`. Each value is the relay's public
   * URL (no trailing slash); the per-cell AS issuer becomes
   * `<origin>/r/<run-id>/<revision>/<scenario>`.
   */
  auxOrigins?: Partial<Record<AuxOriginRole, string>>;
  /**
   * Optional persistence so results survive being load-balanced across
   * processes (serverless isolates). Omit for a single long-lived process.
   */
  store?: RunStore;
}

/** Results view: the cell plus its judged checks. */
export interface RunResults extends CellRef {
  checks: ConformanceCheck[];
  /**
   * How many checks were recorded from traffic: the scenario's own raw log
   * (before judgement, which may add "expected but never seen" failures)
   * plus the hosted layer's FAILUREs (a request the wire turned away is
   * traffic too), but not its INFO checks. Zero means nothing was exercised
   * at the cell's revision: also zero when nothing failed and the client
   * never spoke it (see judgedAtRevision()).
   */
  recorded: number;
  /**
   * When the client last sent the cell a request (ISO 8601), as any process
   * saw it; absent when nothing records one.
   */
  lastRequestAt?: string;
  /**
   * The cell has handed the client something to put before a person (an
   * MRTR input_required result, a request on a stream still open) that no
   * answer has closed yet.
   */
  awaitingInput?: true;
  /** The attempt these results are from: the cell's current one. */
  attempt?: number;
  /** When a reset started the current attempt (ISO 8601). */
  resetAt?: string;
  /**
   * Nothing has reached the current attempt yet: the cell was reset and the
   * client has not sent it a request since.
   */
  fresh?: true;
  /** The attempts before the current one, oldest first, each judged. */
  earlier?: EarlierAttempt[];
}

/** An attempt before a cell's current one, as its results page lists it. */
export interface EarlierAttempt {
  attempt: number;
  /** When a reset started it (ISO 8601); absent for the first. */
  startedAt?: string;
  results: Pick<
    RunResults,
    'checks' | 'recorded' | 'lastRequestAt' | 'awaitingInput'
  >;
}

/** Hosted checks that count as exercise: what went wrong on the wire. */
function hostedFailures(checks: ConformanceCheck[]): number {
  return checks.filter((c) => c.status === 'FAILURE').length;
}

/**
 * The scenario's raw event log — what it actually observed — as opposed to
 * getChecks(), which for most client scenarios also appends "expected X,
 * never saw it" FAILUREs (and mutates). Persisting the raw log per process
 * and judging the merged log once is what makes multi-process hosting work.
 */
export function rawChecksOf(scenario: Scenario): ConformanceCheck[] {
  if (scenario.rawChecks) return scenario.rawChecks();
  const bag = (scenario as unknown as { checks?: unknown }).checks;
  if (Array.isArray(bag)) return bag as ConformanceCheck[];
  return scenario.getChecks();
}

/**
 * The scenario's log as an array the hosted server can seed from the store:
 * its plain `checks` array (what finalizeChecks() re-judges), when its
 * rawChecks(), if it has one, reads that same array. A scenario whose raw
 * view is something else is not seeded. A rebuilt cell that is not seeded
 * writes its process's row over with only what it saw since the rebuild.
 */
function seedableLog(scenario: Scenario): ConformanceCheck[] | undefined {
  const bag = (scenario as unknown as { checks?: unknown }).checks;
  if (!Array.isArray(bag)) return undefined;
  if (scenario.rawChecks && scenario.rawChecks() !== bag) return undefined;
  return bag as ConformanceCheck[];
}

/**
 * New, unstarted instance of a registered scenario. Prefers `Scenario.fresh()`
 * so scenarios registered with constructor parameters keep them; falls back
 * to the no-arg constructor.
 */
export function freshScenario(proto: Scenario): Scenario {
  if (typeof proto.fresh === 'function') return proto.fresh();
  const Ctor = proto.constructor as new () => Scenario;
  return new Ctor();
}

/**
 * Judge a merged raw log with the scenario's own end-of-run logic by loading
 * it into a fresh instance. Falls back to the raw log for scenarios that
 * don't keep a plain `checks` array.
 */
export function finalizeChecks(
  scenarioName: string,
  merged: ConformanceCheck[],
  revision?: SpecVersion
): ConformanceCheck[] {
  const proto = hostedScenarios.get(scenarioName);
  if (!proto) return merged;
  try {
    const scenario = freshScenario(proto);
    if (revision) scenario.judgeAt?.(revision);
    const fresh = scenario as unknown as {
      checks?: unknown;
      getChecks(): ConformanceCheck[];
    };
    if (!Array.isArray(fresh.checks)) return merged;
    fresh.checks = merged.map((c) => ({ ...c }));
    return fresh.getChecks();
  } catch {
    return merged;
  }
}

/** Default SessionManagerOptions.ttlMs (and the CLI's `--ttl`). */
export const DEFAULT_CELL_TTL_MS = 5 * 60_000;

export class SessionManager {
  private runs = new Map<string, HostedRun>();
  /** How long a cell with no request stays in this process's memory. */
  readonly ttlMs: number;
  private readonly auxOrigins: Partial<Record<AuxOriginRole, string>>;
  private sweeper: ReturnType<typeof setInterval>;
  readonly store: RunStore | undefined;
  private pending = new Set<Promise<void>>();
  /** Identifies this process's rows in the store. */
  readonly writerId = randomBytes(4).toString('hex');
  /** Cells built so far, numbering each build's hosted row. */
  private builds = 0;
  /**
   * Cells whose scenario row this process has written, whichever build of
   * the cell wrote it: only such a row can be written over with less.
   */
  private ownRows = new Set<string>();
  /** Without a store: the challenge notes (see noteChallenge()). */
  private challenges = new MemoryRunStore();
  /**
   * Without a store: each cell's attempts, and what its earlier attempts
   * recorded (see renew()). This process is the only one.
   */
  private local = new MemoryRunStore();

  /** Where a cell's attempts and traffic live. */
  private get cells(): RunStore {
    return this.store ?? this.local;
  }

  /** The row id of this process's scenario checks for the run's attempt. */
  private rowOf(run: HostedRun): string {
    return attemptWriter(this.writerId, run.attempt);
  }

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_CELL_TTL_MS;
    this.auxOrigins = opts.auxOrigins ?? {};
    this.store = opts.store;
    const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref?.();
  }

  /**
   * Get the cell, creating it on first reference. `baseUrlFor` is the public
   * URL of the cell (no trailing slash) — the scenario embeds it in
   * self-referential responses (PRM `resource`, canary `$ref`s).
   */
  getOrCreate(ref: CellRef, baseUrlFor: (ref: CellRef) => string): HostedRun {
    const id = cellId(ref);
    const existing = this.runs.get(id);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }

    const proto = hostedScenarios.get(ref.scenarioName);
    if (!proto) throw new UnknownScenarioError(ref.scenarioName);
    const build = () => this.buildCell(ref, id, proto, baseUrlFor);
    const run: HostedRun = {
      ...ref,
      id,
      ...build(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      saved: false,
      touched: false,
      hostedChecks: [],
      hostedWriter: `${this.writerId}.${++this.builds}${HOSTED_WRITER_SUFFIX}`,
      identities: new Map(),
      hostedKeys: new Set(),
      seeded: new Map(),
      written: new Map(),
      attempt: 1,
      traffic: emptyRow(),
      trafficSize: { bytes: 0 },
      refused: new Set(),
      build
    };
    this.runs.set(id, run);
    return run;
  }

  /** A fresh scenario for the cell and the handlers it mounts. */
  private buildCell(
    ref: CellRef,
    id: string,
    proto: Scenario,
    baseUrlFor: (ref: CellRef) => string
  ): CellParts {
    const scenario = freshScenario(proto);
    const ctx = hostedScenarioContext(ref.revision);

    let listener: RequestListener;
    let auxListeners: HostedRun['auxListeners'];
    let context: Record<string, unknown> | undefined;

    if (scenario instanceof AuthHandlerScenario) {
      // Multi-origin scenario: build RS + aux handlers from authHandlers().
      // Aux issuer is <relay-origin>/r/<cell-id> so the cell is recoverable
      // from any RFC 8414 well-known path the client constructs from it.
      const missing = scenario.auxRoles.filter((r) => !this.auxOrigins[r]);
      if (missing.length) {
        throw new NotHostableError(
          ref.scenarioName,
          missingRelaysReason(missing)
        );
      }
      const handlers = scenario.authHandlers({
        ...ctx,
        getRsBaseUrl: () => baseUrlFor(ref),
        getAuxBaseUrl: (role) => `${this.auxOrigins[role]}/r/${id}`
      });
      listener = handlers.rs;
      auxListeners = handlers.aux;
    } else if (scenario.handler) {
      listener = scenario.handler(() => baseUrlFor(ref), ctx);
    } else {
      throw new NotHostableError(ref.scenarioName);
    }

    // What start() would hand the CLI runner's client (credentials, tool
    // arguments, …): a hosted cell never runs start(), so ask directly.
    context = (
      scenario as unknown as {
        scenarioContext?: () => Record<string, unknown>;
      }
    ).scenarioContext?.();
    const steps = (scenario as Scenario).steps;
    if (steps) context = { ...context, steps };
    return {
      scenario,
      listener,
      auxListeners,
      mcpPath: scenario.mcpPath ?? '',
      context
    };
  }

  /**
   * getOrCreate() plus hydrate(): the cell, seeded with what other processes
   * already recorded about it. What every request must go through before it
   * is dispatched, so a scenario that keys its behaviour on its own log (the
   * one-time rejection in request-metadata, say) sees the run's history and
   * not just this process's.
   */
  async acquire(
    ref: CellRef,
    baseUrlFor: (ref: CellRef) => string
  ): Promise<HostedRun> {
    await loadCells([ref]);
    const run = this.getOrCreate(ref, baseUrlFor);
    await this.ready(run);
    return run;
  }

  /**
   * Seed the cell's scenario with the merged raw log the store holds for it,
   * once per cell per process. Only scenarios that keep a plain `checks`
   * array can be seeded (the same ones finalizeChecks() can re-judge); the
   * rest are left alone. Rows this process wrote itself (a cell evicted and
   * rebuilt) are loaded as its own, so they are persisted again rather than
   * dropped from its row. The hosted layer's rows are not seeded: each build
   * of a cell writes its own (HostedRun.hostedWriter). Without a store this
   * settles at once. It never rejects: when the store cannot be read, the
   * cell is served as it stands, `hydrated` stays unset and the next call
   * tries again.
   */
  hydrate(run: HostedRun): Promise<void> {
    if (run.hydration) return run.hydration;
    const store = this.store;
    if (!store) {
      run.hydrated = true;
      return (run.hydration = Promise.resolve());
    }
    const attempt: Promise<void> = (async () => {
      // A cell moved to a newer attempt meanwhile (renew()) seeds itself.
      const scenario = run.scenario;
      const bag = seedableLog(scenario);
      if (!bag) {
        run.hydrated = true;
        return;
      }
      const byWriter = await retrying(() => store.loadChecks(run.id));
      if (run.scenario !== scenario) return;
      run.hydrated = true;
      const own = this.rowOf(run);
      const merged: ConformanceCheck[] = [];
      for (const [writer, checks] of byWriter) {
        if (writer.endsWith(HOSTED_WRITER_SUFFIX)) continue;
        if (attemptOfWriter(writer) !== run.attempt) continue;
        for (const c of checks) {
          const copy = { ...c };
          if (writer !== own) run.seeded.set(copy, JSON.stringify(copy));
          merged.push(copy);
        }
      }
      if (!merged.length) return;
      merged.sort(byTime);
      bag.unshift(...merged);
    })().catch((e: unknown) => {
      logStoreError(e);
      if (run.hydration === attempt) run.hydration = undefined;
    });
    run.hydration = attempt;
    return attempt;
  }

  /**
   * What a request goes through before it is dispatched: the cell seeded
   * from the store (hydrate()), and for a scenario that decides how to
   * answer from its log (Scenario.answersFromLog), what other processes
   * have recorded since. Without that, a process whose copy of the log
   * predates another's request answers as if it had not happened.
   */
  async ready(run: HostedRun): Promise<void> {
    const seededBefore = run.hydrated === true;
    const scenario = run.scenario;
    // Whether the cell was reset since, read beside the seeding: a reset
    // in another process means a fresh scenario here, seeded afresh.
    await Promise.all([this.syncAttempt(run), this.hydrate(run)]);
    if (run.scenario !== scenario) await this.hydrate(run);
    else if (seededBefore && run.scenario.answersFromLog)
      await this.refresh(run);
  }

  /**
   * Move the cell to the store's current attempt if it has been reset
   * since this process built it. When the store cannot be read, the cell
   * is served as it stands.
   */
  private async syncAttempt(run: HostedRun): Promise<void> {
    let resets: number[];
    try {
      resets = await retrying(() => this.cells.loadAttempts(run.id));
    } catch (e) {
      logStoreError(e);
      return;
    }
    const attempt = resets.length + 1;
    if (attempt > run.attempt) await this.renewTo(run, attempt);
  }

  /** renew() once per newer attempt, however many requests notice it. */
  private renewTo(run: HostedRun, attempt: number): Promise<void> {
    const next = (run.renewal ?? Promise.resolve()).then(() =>
      attempt > run.attempt ? this.renew(run, attempt) : undefined
    );
    run.renewal = next.catch(logStoreError);
    return run.renewal;
  }

  /**
   * Start attempt `attempt` at the cell in this process: a fresh scenario
   * and handlers, so nothing the client did before (a registration, a
   * token, a step the scenario counts) carries over, and new rows for its
   * checks and traffic. What the finished attempt recorded stays where it
   * is: its last write lands first, and without a store it is kept in
   * this process for results() to list. Every credential an earlier
   * attempt issued, in any process, is refused from now on (see
   * refusedCredential()).
   */
  private async renew(run: HostedRun, attempt: number): Promise<void> {
    if (run.lastWrite) await run.lastWrite;
    const refused = new Set(run.refused);
    for (const h of run.traffic.issued) refused.add(h);
    if (!this.store && run.touched) {
      const raw = rawChecksOf(run.scenario).map((c) => ({ ...c }));
      await this.local.saveChecks(run.id, this.rowOf(run), raw);
      await this.local.saveChecks(run.id, run.hostedWriter, [
        ...run.hostedChecks.map((c) => ({ ...c }))
      ]);
      await this.local.saveTraffic(run.id, run.hostedWriter, run.traffic);
    }
    try {
      const rows = await retrying(() => this.cells.loadTraffic(run.id));
      for (const [writer, row] of rows) {
        if (attemptOfWriter(writer) >= attempt) continue;
        for (const h of row.issued) refused.add(h);
      }
    } catch (e) {
      logStoreError(e);
    }
    if (attempt <= run.attempt) return;
    const old = run.scenario;
    Object.assign(run, run.build(), {
      attempt,
      hostedChecks: [],
      hostedWriter: attemptWriter(
        `${this.writerId}.${++this.builds}${HOSTED_WRITER_SUFFIX}`,
        attempt
      ),
      identities: new Map(),
      hostedKeys: new Set(),
      seeded: new Map(),
      written: new Map(),
      hydration: undefined,
      hydrated: undefined,
      traffic: emptyRow(),
      trafficSize: { bytes: 0 },
      trafficWritten: undefined,
      refused
    } satisfies Partial<HostedRun>);
    try {
      await old.stop();
    } catch {
      // best-effort, as in destroy()
    }
  }

  /**
   * Reset cell `id`: start a new attempt, at `at`, which the client's next
   * request opens. The cell keeps its URL; what earlier attempts recorded
   * stays and is listed under the latest. Returns the new attempt's number.
   */
  async reset(id: string, at: number = Date.now()): Promise<number> {
    const cells = this.cells;
    let attempt: number;
    try {
      attempt = await retrying(() => cells.startAttempt(id, at));
    } catch (e) {
      logStoreError(e);
      throw new StoreUnavailableError(e);
    }
    const run = this.runs.get(id);
    if (run) await this.renewTo(run, attempt);
    return attempt;
  }

  /**
   * Add an exchange to the cell's traffic (see addExchange()): the entry
   * the row holds for it, or undefined when the row is at its cap.
   */
  recordExchange(run: HostedRun, exchange: Exchange): Exchange | undefined {
    return addExchange(run.traffic, exchange, run.trafficSize);
  }

  /** Note the credentials a response of the cell's issued (hashes). */
  noteIssued(run: HostedRun, hashes: readonly string[]): void {
    addIssued(run.traffic, hashes);
  }

  /**
   * Add to the cell's scenario log, in time order, the checks other
   * processes have written since it was seeded. Each is marked seeded, so
   * it stays its writer's to persist. When the store cannot be read, the
   * cell is served as it stands.
   */
  private async refresh(run: HostedRun): Promise<void> {
    const store = this.store;
    const log = seedableLog(run.scenario);
    if (!store || !log) return;
    let byWriter: Map<string, ConformanceCheck[]>;
    try {
      byWriter = await retrying(() => store.loadChecks(run.id));
    } catch (e) {
      logStoreError(e);
      return;
    }
    const known = new Set(run.seeded.values());
    const fresh: ConformanceCheck[] = [];
    const own = this.rowOf(run);
    for (const [writer, checks] of byWriter) {
      if (writer === own || writer.endsWith(HOSTED_WRITER_SUFFIX)) continue;
      if (attemptOfWriter(writer) !== run.attempt) continue;
      for (const c of checks) {
        const json = JSON.stringify(c);
        if (known.has(json)) continue;
        known.add(json);
        const copy = { ...c };
        run.seeded.set(copy, json);
        fresh.push(copy);
      }
    }
    for (const c of fresh.sort(byTime)) {
      let i = log.length;
      while (i > 0 && byTime(log[i - 1], c) > 0) i--;
      log.splice(i, 0, c);
    }
  }

  /**
   * This process's contribution to the cell's raw log: everything the
   * scenario recorded except seeded checks it has not touched. A seeded
   * check the scenario replaced or rewrote in place is ours to persist.
   */
  ownChecks(run: HostedRun): ConformanceCheck[] {
    const raw = rawChecksOf(run.scenario);
    if (!run.seeded.size) return raw;
    return raw.filter((c) => run.seeded.get(c) !== JSON.stringify(c));
  }

  /**
   * Record a hosted-layer check about the cell once per `key` (what makes
   * the finding distinct — e.g. the rejection's code and message).
   */
  recordHostedCheck(
    run: HostedRun,
    key: string,
    check: ConformanceCheck
  ): void {
    if (run.hostedKeys.has(key)) return;
    run.hostedKeys.add(key);
    run.hostedChecks.push(check);
  }

  /**
   * Record who is talking to the cell — one INFO check per client (name,
   * version), accumulating the protocol versions it negotiated.
   */
  recordIdentity(run: HostedRun, observed: IdentityObservation): void {
    const key = identityKey(observed);
    const existing = run.identities.get(key);
    if (existing) {
      addProtocolVersion(existing, observed.protocolVersion);
      return;
    }
    const check = identityCheck(identityOf(observed));
    run.identities.set(key, check);
    run.hostedChecks.push(check);
  }

  /**
   * Note a request from the client to the cell at `at`, and whether the cell
   * now waits on input the client must collect from a person (undefined
   * leaves that as it stands). The marker is re-stamped at most once per
   * ACTIVITY_RESOLUTION_MS, so a busy client does not rewrite the cell's
   * hosted row on every request: how long a client has been quiet is told
   * in minutes.
   */
  noteActivity(run: HostedRun, awaitingInput?: boolean, at = Date.now()): void {
    const marker = run.hostedChecks.find((c) => c.id === ACTIVITY_CHECK_ID);
    if (!marker) {
      run.hostedChecks.push(activityCheck(at, awaitingInput ?? false));
      return;
    }
    const was = marker.details?.awaitingInput === true;
    const awaiting = awaitingInput ?? was;
    const since = at - Date.parse(marker.timestamp ?? '');
    if (since < ACTIVITY_RESOLUTION_MS && awaiting === was) return;
    marker.timestamp = new Date(at).toISOString();
    marker.details = { awaitingInput: awaiting };
  }

  /**
   * Note that the cell answered a request from `requester` (a keyed hash of
   * the client's address, '' when unknown) with a sign-in challenge (401),
   * so that a later request from the same requester naming no cell can be
   * attributed to it (see ./root-prm.ts). With a store the note is written
   * through and flush() waits for it: a client following the challenge to
   * another process finds it there.
   */
  noteChallenge(run: HostedRun, requester: string, at = Date.now()): void {
    const store = this.store;
    if (!store) {
      // In memory: written before this returns.
      void this.challenges.saveChallenge(run.id, requester, at);
      return;
    }
    const p: Promise<void> = retrying(() =>
      store.saveChallenge(run.id, requester, at)
    )
      .catch(logStoreError)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /**
   * Cells challenged from `requester` in the last `windowMs`, latest first.
   * Never another requester's.
   */
  async recentChallenges(
    windowMs: number,
    requester: string
  ): Promise<Array<{ id: string; at: number }>> {
    const since = Date.now() - windowMs;
    const store = this.store;
    if (!store) return this.challenges.listChallenges(since, requester);
    try {
      return await retrying(() => store.listChallenges(since, requester));
    } catch (e) {
      logStoreError(e);
      throw new StoreUnavailableError(e);
    }
  }

  get(id: string): HostedRun | undefined {
    const r = this.runs.get(id);
    if (r) r.lastSeenAt = Date.now();
    return r;
  }

  /**
   * Like get(), but rebuilds the cell from its id when this process has never
   * seen it — the id carries everything needed. Returns undefined for an id
   * that does not parse or names a scenario this deployment cannot mount.
   */
  ensure(
    id: string,
    baseUrlFor: (ref: CellRef) => string
  ): HostedRun | undefined {
    const local = this.get(id);
    if (local) return local;
    const ref = parseCellId(id);
    if (!ref) return undefined;
    try {
      return this.getOrCreate(ref, baseUrlFor);
    } catch (e) {
      if (e instanceof UnknownScenarioError || e instanceof NotHostableError)
        return undefined;
      throw e;
    }
  }

  /**
   * Write this process's view of a cell's checks through to the store; the
   * first write also records that the cell exists, so a cell that was only
   * configured (never hit) does not show up as exercised. A cell's writes
   * land in order, each with the cell as it stands when the write starts,
   * so an older view never overwrites a newer one.
   */
  persist(run: HostedRun): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    if (run.queuedWrite) return run.queuedWrite;
    const p: Promise<void> = (run.lastWrite ?? Promise.resolve())
      .then(() => {
        run.queuedWrite = undefined;
        return this.write(run, store);
      })
      .catch(logStoreError)
      .finally(() => this.pending.delete(p));
    run.queuedWrite = run.lastWrite = p;
    this.pending.add(p);
    return p;
  }

  /**
   * One write of the cell's rows, sent together: a flush waits one store
   * round trip, not one per row. A row that has not changed since this
   * process last wrote it is not sent again. A store call that fails is
   * made again before the write gives up (see retrying()): on a serverless
   * host the isolate may never see the cell again, so a write left for the
   * next request is often a write lost.
   */
  private async write(run: HostedRun, store: RunStore): Promise<void> {
    // A cell not yet seeded from the store holds only what this process saw
    // since it built the cell: written over this writer's row, that could
    // drop what the writer recorded before the cell was evicted. So it is
    // seeded first; but when it has recorded nothing (a request answered
    // before seeding), its row is left alone and the write waits on nothing
    // but itself. The hosted row needs neither: it is this build's own.
    const ownRow =
      run.hydration !== undefined || rawChecksOf(run.scenario).length > 0;
    if (ownRow) await this.hydrate(run);
    // Unseeded because the store could not be read, the cell is still
    // written if this process has no row for it yet: there is nothing to
    // write over. Otherwise its row waits for a write that can seed first.
    const own = this.rowOf(run);
    const ownKey = `${run.id}#${run.attempt}`;
    const deferred = ownRow && !run.hydrated && this.ownRows.has(ownKey);
    const rows: Array<[string, ConformanceCheck[]]> = [];
    if (ownRow && !deferred) rows.push([own, this.ownChecks(run)]);
    if (run.hostedChecks.length)
      rows.push([run.hostedWriter, run.hostedChecks]);
    const writes: Promise<void>[] = [];
    for (const [writer, checks] of rows) {
      const json = JSON.stringify(checks);
      if (run.written.get(writer) === json) continue;
      writes.push(
        retrying(() =>
          store.saveChecks(
            run.id,
            writer,
            JSON.parse(json) as ConformanceCheck[]
          )
        ).then(() => {
          run.written.set(writer, json);
          if (writer === own) this.ownRows.add(ownKey);
        })
      );
    }
    // The traffic row, with the checks: one round trip for both. A row
    // whose only news is a repeat is left for the next write.
    const traffic = run.traffic;
    const said = substance(traffic);
    if (
      traffic.exchanges.length + traffic.omitted > 0 &&
      said !== run.trafficWritten
    ) {
      const json = JSON.stringify(traffic);
      const writer = run.hostedWriter;
      writes.push(
        retrying(() =>
          store.saveTraffic(run.id, writer, JSON.parse(json) as TrafficRow)
        ).then(() => {
          if (run.traffic === traffic) run.trafficWritten = said;
        })
      );
    }
    if (!run.saved) {
      // Marked saved only once the write landed: a failed saveRun must be
      // retried on the next persist, or the cell never appears in
      // listRuns() and the report shows it as never exercised even though
      // its checks are in the store.
      writes.push(
        retrying(() => store.saveRun(run.id, run.scenarioName)).then(() => {
          run.saved = true;
        })
      );
    }
    // Every write is let finish before a failure is reported, so what did
    // land is remembered and only the rest is retried.
    const failed = (await Promise.allSettled(writes)).find(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    if (failed) throw failed.reason;
    if (deferred) {
      throw new Error(
        `${run.id}: the store could not be read, so this process's row waits for the next write`
      );
    }
  }

  /**
   * Resolve once every in-flight persist() has settled. Serverless entry
   * points await this before handing back the response so the write isn't
   * abandoned when the isolate is frozen after responding.
   */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all(Array.from(this.pending));
  }

  /**
   * Judged checks for a cell, or undefined when neither this process nor the
   * store has seen it. Without a store this is the scenario's own getChecks().
   * With a store it is every process's raw log merged (this process's live
   * log wins over its own persisted row) and re-judged once. The hosted
   * layer's own checks are appended after judgement, deduplicated across
   * processes, so they never influence the scenario's verdicts — though a
   * hosted FAILURE (wire rejection, wrong revision) does decide the cell's.
   */
  async results(id: string): Promise<RunResults | undefined> {
    const ref = parseCellId(id);
    if (!ref) return undefined;
    await hostedScenarios.load([ref.scenarioName]);
    // A cell that only a config page created has seen no client: there is
    // nothing to judge, so it reads like a cell that does not exist yet.
    const run = this.runs.get(id)?.touched ? this.runs.get(id) : undefined;
    if (!this.store) {
      if (!run) return undefined;
      // What earlier attempts recorded, kept here when the cell was reset.
      const [earlierRows, resets] = await Promise.all([
        this.local.loadChecks(id),
        this.local.loadAttempts(id)
      ]);
      const raw = rawChecksOf(run.scenario);
      // Judged on a copy, as with a store: many scenarios' getChecks()
      // appends its "expected but never seen" FAILUREs to the live log, so
      // judging the live instance would let a page view change the verdict.
      const latest = judgedAtRevision(ref, raw, run.hostedChecks);
      return withAttempts(
        ref,
        latest,
        run.attempt,
        resets,
        earlierRows,
        raw.length + run.hostedChecks.length === 0
      );
    }
    // A cell built for a discover and not seeded since (see write()) holds
    // less than this process's row: seeded, its log is the whole of it.
    if (run) await this.hydrate(run);
    // A store that cannot be read is said so (StoreUnavailableError), not
    // read as a cell nobody recorded anything for: a report built on that
    // shows every cell empty, and can be frozen that way.
    const store = this.store;
    let byWriter: Map<string, ConformanceCheck[]>;
    let known: boolean;
    let resets: number[];
    try {
      [byWriter, known, resets] = await Promise.all([
        retrying(() => store.loadChecks(id)),
        retrying(() => store.loadRun(id)).then((s) => s !== undefined),
        retrying(() => store.loadAttempts(id))
      ]);
    } catch (e) {
      logStoreError(e);
      throw new StoreUnavailableError(e);
    }
    if (run) {
      byWriter.set(this.rowOf(run), this.ownChecks(run));
      byWriter.set(run.hostedWriter, run.hostedChecks);
    }
    if (!run && !known && byWriter.size === 0) return undefined;
    const current = Math.max(
      resets.length + 1,
      run?.attempt ?? 1,
      ...Array.from(byWriter.keys(), attemptOfWriter)
    );
    const latest = new Map<string, ConformanceCheck[]>();
    const earlierRows = new Map<string, ConformanceCheck[]>();
    for (const [writer, checks] of byWriter) {
      (attemptOfWriter(writer) === current ? latest : earlierRows).set(
        writer,
        checks
      );
    }
    const fresh = Array.from(latest.values()).every((c) => c.length === 0);
    return withAttempts(
      ref,
      judgedRows(ref, latest),
      current,
      resets,
      earlierRows,
      fresh
    );
  }

  /**
   * The cell's traffic by attempt (see ./traffic.ts): every process's rows
   * merged in time order, this process's live row included.
   */
  async traffic(
    id: string
  ): Promise<Map<number, { exchanges: Exchange[]; omitted: number }>> {
    const run = this.runs.get(id)?.touched ? this.runs.get(id) : undefined;
    let rows: Map<string, TrafficRow>;
    try {
      rows = await retrying(() => this.cells.loadTraffic(id));
    } catch (e) {
      logStoreError(e);
      throw new StoreUnavailableError(e);
    }
    if (run) rows.set(run.hostedWriter, run.traffic);
    const byAttempt = new Map<number, TrafficRow[]>();
    for (const [writer, row] of rows) {
      const n = attemptOfWriter(writer);
      byAttempt.set(n, [...(byAttempt.get(n) ?? []), row]);
    }
    return new Map(
      Array.from(byAttempt, ([n, list]) => [n, mergeRows(list)] as const).sort(
        (a, b) => a[0] - b[0]
      )
    );
  }

  /** Exercised cells of a run: hit in this process, or saved to the store. */
  async listCells(runId: string): Promise<CellRef[]> {
    const ids = new Set<string>();
    for (const r of this.runs.values()) {
      if (r.runId === runId && r.touched) ids.add(r.id);
    }
    const store = this.store;
    if (store) {
      try {
        const saved = await retrying(() => store.listRuns(`${runId}/`));
        for (const { id } of saved) ids.add(id);
      } catch (e) {
        logStoreError(e);
        throw new StoreUnavailableError(e);
      }
    }
    return Array.from(ids)
      .map(parseCellId)
      .filter((r): r is CellRef => r !== undefined);
  }

  list(): HostedRun[] {
    return Array.from(this.runs.values());
  }

  async destroy(id: string, fromStore = true): Promise<void> {
    const r = this.runs.get(id);
    if (fromStore) void this.store?.deleteRun(id).catch(logStoreError);
    if (!r) return;
    this.runs.delete(id);
    // handler() never started a server, but some scenarios hold timers/streams
    // that stop() cleans up. Safe to call even though start() wasn't.
    try {
      await r.scenario.stop();
    } catch {
      // best-effort
    }
  }

  /** Tear down every cell of a run, here and in the store. */
  async destroyRun(runId: string): Promise<void> {
    const cells = await this.listCells(runId);
    await Promise.all(cells.map((ref) => this.destroy(cellId(ref))));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all(
      Array.from(this.runs.keys()).map((id) => this.destroy(id, false))
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, r] of this.runs) {
      // Local eviction only — the store has its own retention.
      if (now - r.lastSeenAt > this.ttlMs) void this.destroy(id, false);
    }
  }
}

/** How often a cell's activity marker is re-stamped at most (noteActivity()). */
export const ACTIVITY_RESOLUTION_MS = 15_000;

const byTime = (a: ConformanceCheck, b: ConformanceCheck) =>
  (a.timestamp ?? '').localeCompare(b.timestamp ?? '');

/**
 * Judge one attempt's rows, keyed by writer: the scenario's rows merged, the
 * hosted layer's deduplicated across processes, and both judged at the
 * cell's revision (judgedAtRevision()). The hosted layer's own checks are
 * appended after judgement, so they never influence the scenario's
 * verdicts — though a hosted FAILURE (wire rejection, wrong revision) does
 * decide the cell's.
 */
function judgedRows(
  ref: CellRef,
  byWriter: ReadonlyMap<string, ConformanceCheck[]>
): RunResults {
  const scenarioLog: ConformanceCheck[] = [];
  const hostedLog: ConformanceCheck[] = [];
  for (const [writer, checks] of byWriter) {
    (writer.endsWith(HOSTED_WRITER_SUFFIX) ? hostedLog : scenarioLog).push(
      ...checks
    );
  }
  // Identity checks collapse to one per client (their protocol versions
  // pooled); every other hosted finding is one check per distinct details.
  const seen = new Set<string>();
  hostedLog.sort(byTime);
  const hosted = [
    ...identityChecksIn(hostedLog),
    ...hostedLog.filter((c) => {
      if (c.id === IDENTITY_CHECK_ID) return false;
      // Every process's activity marker, so the latest can be read.
      if (c.id === ACTIVITY_CHECK_ID) return true;
      const key = `${c.id}:${JSON.stringify(c.details ?? null)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  ].sort(byTime);
  return judgedAtRevision(ref, scenarioLog.sort(byTime), hosted);
}

/**
 * `latest`, the current attempt's results, with the attempt's number, when
 * a reset started it, whether nothing has reached it yet (`fresh`), and
 * each earlier attempt judged from its own rows (`earlierRows`, keyed by
 * writer; see attemptOfWriter()).
 */
function withAttempts(
  ref: CellRef,
  latest: RunResults,
  attempt: number,
  resets: readonly number[],
  earlierRows: ReadonlyMap<string, ConformanceCheck[]>,
  fresh: boolean
): RunResults {
  if (attempt === 1) return { ...latest, attempt };
  const iso = (ms: number | undefined) =>
    ms === undefined ? undefined : new Date(ms).toISOString();
  const earlier: EarlierAttempt[] = [];
  for (let n = 1; n < attempt; n++) {
    const rows = new Map(
      Array.from(earlierRows).filter(([w]) => attemptOfWriter(w) === n)
    );
    if (!rows.size) continue;
    const { checks, recorded, lastRequestAt, awaitingInput } = judgedRows(
      ref,
      rows
    );
    const startedAt = n > 1 ? iso(resets[n - 2]) : undefined;
    earlier.push({
      attempt: n,
      ...(startedAt && { startedAt }),
      results: {
        checks,
        recorded,
        ...(lastRequestAt && { lastRequestAt }),
        ...(awaitingInput && { awaitingInput })
      }
    });
  }
  const resetAt = iso(resets[attempt - 2]);
  return {
    ...latest,
    attempt,
    ...(resetAt && { resetAt }),
    ...(fresh && { fresh: true as const }),
    ...(earlier.length && { earlier })
  };
}

/**
 * A cell's results from its scenario's raw log (merged across processes)
 * and the hosted layer's checks: the scenario's judgement, as a cell served
 * on its revision reads it (atCellRevision()), then the hosted checks.
 *
 * A cell must not pass on checks recorded around the protocol — a finished
 * OAuth flow, say — when the client never spoke the cell's revision there:
 * without a REVISION_SPOKEN_CHECK_ID marker (spokeRevision()) and with no
 * FAILURE, `recorded` is zero, so the verdict is incomplete, and the cell
 * says why (revisionNotSpokenCheck()). A scenario that expects the client
 * to stop before it is let in (`allowClientError`: it must reject a bad
 * issuer, say) passes once the client sent the cell an MCP request at its
 * revision, even one met with the sign-in challenge (reachedRevision());
 * metadata fetches alone, as a client listing its servers makes, are not
 * enough. The markers themselves are never shown.
 */
function judgedAtRevision(
  ref: CellRef,
  scenarioLog: ConformanceCheck[],
  hostedLog: ConformanceCheck[]
): RunResults {
  const spoke = hostedLog.some((c) => c.id === REVISION_SPOKEN_CHECK_ID);
  // A client that signed in and was then stopped by the auth layer reached
  // the cell too, whatever revision that request carried (see
  // signedInAuthStop()).
  const reached =
    spoke ||
    hostedLog.some((c) => c.id === REVISION_REACHED_CHECK_ID) ||
    signedInAuthStop(hostedLog, scenarioLog);
  const tested = hostedScenarios.meta(ref.scenarioName)?.allowClientError
    ? reached
    : spoke;
  const hosted = hostedLog.filter(
    (c) =>
      c.id !== REVISION_SPOKEN_CHECK_ID &&
      c.id !== REVISION_REACHED_CHECK_ID &&
      c.id !== AUTH_STOP_CHECK_ID &&
      c.id !== ACTIVITY_CHECK_ID
  );
  const checks = [
    ...atCellRevision(
      finalizeChecks(ref.scenarioName, scenarioLog, ref.revision),
      ref.revision
    ),
    ...hosted
  ];
  let recorded = scenarioLog.length + hostedFailures(hosted);
  if (recorded > 0 && !tested && !checks.some((c) => c.status === 'FAILURE')) {
    const last = checks.reduce(
      (t, c) => ((c.timestamp ?? '') > t ? (c.timestamp ?? '') : t),
      ''
    );
    checks.push(
      revisionNotSpokenCheck(ref.revision, last || new Date().toISOString())
    );
    recorded = 0;
  }
  // When the client last sent the cell anything, as any process saw it: the
  // activity markers (re-stamped as requests come) and the logs' own times.
  const lastRequestAt = [...scenarioLog, ...hostedLog].reduce(
    (t, c) => ((c.timestamp ?? '') > t ? (c.timestamp ?? '') : t),
    ''
  );
  const latest = hostedLog
    .filter((c) => c.id === ACTIVITY_CHECK_ID)
    .reduce<
      ConformanceCheck | undefined
    >((m, c) => (!m || (c.timestamp ?? '') > (m.timestamp ?? '') ? c : m), undefined);
  const awaitingInput = latest?.details?.awaitingInput === true;
  return {
    ...ref,
    checks,
    recorded,
    ...(lastRequestAt && { lastRequestAt }),
    ...(awaitingInput && { awaitingInput })
  };
}

function logStoreError(e: unknown): void {
  console.error('[hosted] run store:', e instanceof Error ? e.message : e);
}

/** Waits before each repeat of a store call that failed (see retrying()). */
const STORE_RETRY_DELAYS_MS = [50, 250];

/**
 * A store call, made again after a short wait when it fails: a hosted
 * SQLite API can refuse a statement now and then, and a write not made
 * again before the response may never be made.
 */
async function retrying<T>(call: () => Promise<T>): Promise<T> {
  for (const wait of STORE_RETRY_DELAYS_MS) {
    try {
      return await call();
    } catch {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return call();
}

/** The run store could not be read, so a cell's results cannot be told. */
export class StoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `the results store did not answer (${cause instanceof Error ? cause.message : String(cause)}); try again`
    );
  }
}

export class UnknownScenarioError extends Error {
  constructor(name: string) {
    super(
      `Unknown scenario '${name}'. Available: ${hostedScenarios.names.join(', ')}`
    );
  }
}

export class NotHostableError extends Error {
  constructor(name: string, why?: string) {
    super(
      `scenario '${name}' cannot be started here: ${why ?? NOT_HOSTED_REASON}`
    );
  }
}
