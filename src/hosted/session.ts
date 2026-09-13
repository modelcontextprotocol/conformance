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
import { createHandlerFor, type ScenarioContext } from '../mock-server';
import { getScenario, scenarios } from '../scenarios';
import type { RunStore } from './store';
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
import { REVISION_SPOKEN_CHECK_ID, revisionNotSpokenCheck } from './wire';

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
    createHandler: (handlers) => createHandlerFor(specVersion)(handlers)
  };
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
  const proto = getScenario(scenarioName);
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

    const proto = getScenario(ref.scenarioName);
    if (!proto) throw new UnknownScenarioError(ref.scenarioName);

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
          `needs relay origin(s) [${missing.join(', ')}]`
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

    const run: HostedRun = {
      ...ref,
      id,
      scenario,
      listener,
      auxListeners,
      mcpPath: scenario.mcpPath ?? '',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      context,
      saved: false,
      touched: false,
      hostedChecks: [],
      hostedWriter: `${this.writerId}.${++this.builds}${HOSTED_WRITER_SUFFIX}`,
      identities: new Map(),
      hostedKeys: new Set(),
      seeded: new Map(),
      written: new Map()
    };
    this.runs.set(id, run);
    return run;
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
    const run = this.getOrCreate(ref, baseUrlFor);
    await this.hydrate(run);
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
      const bag = (run.scenario as unknown as { checks?: unknown }).checks;
      if (!Array.isArray(bag) || run.scenario.rawChecks) {
        run.hydrated = true;
        return;
      }
      const byWriter = await retrying(() => store.loadChecks(run.id));
      run.hydrated = true;
      const merged: ConformanceCheck[] = [];
      for (const [writer, checks] of byWriter) {
        if (writer.endsWith(HOSTED_WRITER_SUFFIX)) continue;
        for (const c of checks) {
          const copy = { ...c };
          if (writer !== this.writerId)
            run.seeded.set(copy, JSON.stringify(copy));
          merged.push(copy);
        }
      }
      if (!merged.length) return;
      merged.sort(byTime);
      (bag as ConformanceCheck[]).unshift(...merged);
    })().catch((e: unknown) => {
      logStoreError(e);
      if (run.hydration === attempt) run.hydration = undefined;
    });
    run.hydration = attempt;
    return attempt;
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
    const deferred = ownRow && !run.hydrated && this.ownRows.has(run.id);
    const rows: Array<[string, ConformanceCheck[]]> = [];
    if (ownRow && !deferred) rows.push([this.writerId, this.ownChecks(run)]);
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
          if (writer === this.writerId) this.ownRows.add(run.id);
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
    // A cell that only a config page created has seen no client: there is
    // nothing to judge, so it reads like a cell that does not exist yet.
    const run = this.runs.get(id)?.touched ? this.runs.get(id) : undefined;
    if (!this.store) {
      if (!run) return undefined;
      const raw = rawChecksOf(run.scenario);
      // Judged on a copy, as with a store: many scenarios' getChecks()
      // appends its "expected but never seen" FAILUREs to the live log, so
      // judging the live instance would let a page view change the verdict.
      return judgedAtRevision(ref, raw, run.hostedChecks);
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
    try {
      byWriter = await retrying(() => store.loadChecks(id));
      known = (await retrying(() => store.loadRun(id))) !== undefined;
    } catch (e) {
      logStoreError(e);
      throw new StoreUnavailableError(e);
    }
    if (run) {
      byWriter.set(this.writerId, this.ownChecks(run));
      byWriter.set(run.hostedWriter, run.hostedChecks);
    }
    if (!run && !known && byWriter.size === 0) return undefined;
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
        const key = `${c.id}:${JSON.stringify(c.details ?? null)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    ].sort(byTime);
    return judgedAtRevision(ref, scenarioLog.sort(byTime), hosted);
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

const byTime = (a: ConformanceCheck, b: ConformanceCheck) =>
  (a.timestamp ?? '').localeCompare(b.timestamp ?? '');

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
 * to stop before it reaches the MCP endpoint (`allowClientError`: it must
 * reject a bad issuer, say) is judged on its own checks as before. The
 * markers themselves are never shown.
 */
function judgedAtRevision(
  ref: CellRef,
  scenarioLog: ConformanceCheck[],
  hostedLog: ConformanceCheck[]
): RunResults {
  const spoke = hostedLog.some((c) => c.id === REVISION_SPOKEN_CHECK_ID);
  const hosted = hostedLog.filter((c) => c.id !== REVISION_SPOKEN_CHECK_ID);
  const checks = [
    ...atCellRevision(
      finalizeChecks(ref.scenarioName, scenarioLog, ref.revision),
      ref.revision
    ),
    ...hosted
  ];
  let recorded = scenarioLog.length + hostedFailures(hosted);
  if (
    recorded > 0 &&
    !spoke &&
    !getScenario(ref.scenarioName)?.allowClientError &&
    !checks.some((c) => c.status === 'FAILURE')
  ) {
    const last = checks.reduce(
      (t, c) => ((c.timestamp ?? '') > t ? (c.timestamp ?? '') : t),
      ''
    );
    checks.push(
      revisionNotSpokenCheck(ref.revision, last || new Date().toISOString())
    );
    recorded = 0;
  }
  return { ...ref, checks, recorded };
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
      `Unknown scenario '${name}'. Available: ${Array.from(scenarios.keys()).join(', ')}`
    );
  }
}

export class NotHostableError extends Error {
  constructor(name: string, why?: string) {
    super(
      `Scenario '${name}' cannot run hosted` +
        (why ? `: ${why}` : ' (not converted for hosting yet)')
    );
  }
}
