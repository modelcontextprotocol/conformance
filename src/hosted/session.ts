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
import { identityCheck, identityKey, type ClientIdentity } from './identity';

/** Store writer suffix for the hosted layer's own checks (client identity). */
const HOSTED_WRITER_SUFFIX = '/hosted';

/** Run ids are one path segment: safe in URLs and after the relay's /r/. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function mintRunId(): string {
  return randomBytes(6).toString('base64url');
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
   * Checks the hosted layer records about the cell (client identity), kept
   * apart from the scenario's own log so they never enter its judgement.
   */
  hostedChecks: ConformanceCheck[];
  /** Identity keys already recorded, so one client is one INFO check. */
  identities: Set<string>;
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
   * How many checks the scenario itself recorded (before judgement, which
   * may add "expected but never seen" failures, and without the hosted
   * layer's own INFO checks). Zero means nothing was exercised.
   */
  recorded: number;
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
  merged: ConformanceCheck[]
): ConformanceCheck[] {
  const proto = getScenario(scenarioName);
  if (!proto) return merged;
  try {
    const fresh = freshScenario(proto) as unknown as {
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

export class SessionManager {
  private runs = new Map<string, HostedRun>();
  private readonly ttlMs: number;
  private readonly auxOrigins: Partial<Record<AuxOriginRole, string>>;
  private sweeper: ReturnType<typeof setInterval>;
  readonly store: RunStore | undefined;
  private pending = new Set<Promise<void>>();
  /** Identifies this process's rows in the store. */
  readonly writerId = randomBytes(4).toString('hex');

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
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
      context = (
        scenario as unknown as {
          scenarioContext?: () => Record<string, unknown>;
        }
      ).scenarioContext?.();
    } else if (scenario.handler) {
      listener = scenario.handler(() => baseUrlFor(ref), ctx);
    } else {
      throw new NotHostableError(ref.scenarioName);
    }

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
      identities: new Set()
    };
    this.runs.set(id, run);
    return run;
  }

  /** Record who is talking to the cell — once per distinct identity. */
  recordIdentity(run: HostedRun, identity: ClientIdentity): void {
    const key = identityKey(identity);
    if (run.identities.has(key)) return;
    run.identities.add(key);
    run.hostedChecks.push(identityCheck(identity));
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
   * configured (never hit) does not show up as exercised.
   */
  persist(run: HostedRun): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    const p = (async () => {
      if (!run.saved) {
        // Mark saved only once the write landed: a failed saveRun must be
        // retried on the next persist, or the cell never appears in
        // listRuns() and the report shows it as never exercised even though
        // its checks are in the store.
        await store.saveRun(run.id, run.scenarioName);
        run.saved = true;
      }
      await store.saveChecks(
        run.id,
        this.writerId,
        rawChecksOf(run.scenario).map((c) => ({ ...c }))
      );
      if (run.hostedChecks.length) {
        await store.saveChecks(
          run.id,
          this.writerId + HOSTED_WRITER_SUFFIX,
          run.hostedChecks.map((c) => ({ ...c }))
        );
      }
    })()
      .catch(logStoreError)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
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
   * processes, so they never influence the scenario's verdicts.
   */
  async results(id: string): Promise<RunResults | undefined> {
    const ref = parseCellId(id);
    if (!ref) return undefined;
    const run = this.runs.get(id);
    if (!this.store) {
      if (!run) return undefined;
      const recorded = rawChecksOf(run.scenario).length;
      return {
        ...ref,
        checks: [...run.scenario.getChecks(), ...run.hostedChecks],
        recorded
      };
    }
    let byWriter = new Map<string, ConformanceCheck[]>();
    let known = false;
    try {
      byWriter = await this.store.loadChecks(id);
      known = (await this.store.loadRun(id)) !== undefined;
    } catch (e) {
      logStoreError(e);
    }
    if (run) {
      byWriter.set(this.writerId, rawChecksOf(run.scenario));
      byWriter.set(this.writerId + HOSTED_WRITER_SUFFIX, run.hostedChecks);
    }
    if (!run && !known && byWriter.size === 0) return undefined;
    const byTime = (a: ConformanceCheck, b: ConformanceCheck) =>
      (a.timestamp ?? '').localeCompare(b.timestamp ?? '');
    const scenarioLog: ConformanceCheck[] = [];
    const hostedLog: ConformanceCheck[] = [];
    for (const [writer, checks] of byWriter) {
      (writer.endsWith(HOSTED_WRITER_SUFFIX) ? hostedLog : scenarioLog).push(
        ...checks
      );
    }
    const seen = new Set<string>();
    const hosted = hostedLog.sort(byTime).filter((c) => {
      const key = `${c.id}:${JSON.stringify(c.details ?? null)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...ref,
      checks: [
        ...finalizeChecks(ref.scenarioName, scenarioLog.sort(byTime)),
        ...hosted
      ],
      recorded: scenarioLog.length
    };
  }

  /** Exercised cells of a run: hit in this process, or saved to the store. */
  async listCells(runId: string): Promise<CellRef[]> {
    const ids = new Set<string>();
    for (const r of this.runs.values()) {
      if (r.runId === runId && r.touched) ids.add(r.id);
    }
    if (this.store) {
      try {
        for (const { id } of await this.store.listRuns(`${runId}/`))
          ids.add(id);
      } catch (e) {
        logStoreError(e);
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

function logStoreError(e: unknown): void {
  console.error('[hosted] run store:', e instanceof Error ? e.message : e);
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
