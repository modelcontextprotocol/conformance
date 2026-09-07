/**
 * Session management for the hosted conformance server.
 *
 * A "run" is one isolated exercise of a scenario. Each run owns a fresh
 * Scenario instance and the RequestListener it returns from handler() — no
 * loopback port, no proxy. Runs are keyed by a path-embedded id so
 * correlation works for stateless-transport clients that never echo
 * mcp-session-id.
 */

import { randomBytes } from 'crypto';
import {
  Scenario,
  ConformanceCheck,
  RequestListener,
  AuthHandlerScenario,
  AuxOriginRole
} from '../types';
import { getScenario, scenarios } from '../scenarios';
import type { RunStore } from './store';

export interface HostedRun {
  id: string;
  scenarioName: string;
  scenario: Scenario;
  /** The mounted RS handler — invoke directly with (req, res). */
  listener: RequestListener;
  /** Aux-origin handlers (AS, IdP, …) for auth scenarios. */
  auxListeners?: Partial<Record<AuxOriginRole, RequestListener>>;
  /** Sub-path under the run prefix where the MCP endpoint lives. */
  mcpPath: string;
  createdAt: number;
  lastSeenAt: number;
  context?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  /** Idle ms after which a run is reaped. Default 5 minutes. */
  ttlMs?: number;
  sweepIntervalMs?: number;
  /**
   * Public origins of the relay deployments, keyed by role. Required for any
   * scenario that exposes `authHandlers()`. Each value is the relay's public
   * URL (no trailing slash); per-run AS issuer becomes `<origin>/r/<run-id>`.
   */
  auxOrigins?: Partial<Record<AuxOriginRole, string>>;
  /**
   * Optional persistence so runs survive being load-balanced across
   * processes (serverless isolates). Omit for a single long-lived process.
   */
  store?: RunStore;
}

/** Results view: the scenario a run belongs to plus its judged checks. */
export interface RunResults {
  scenarioName: string;
  checks: ConformanceCheck[];
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
    const Ctor = proto.constructor as new () => Scenario;
    const fresh = new Ctor() as unknown as {
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
   * Get the run for (scenario, id), creating it on first reference. The id is
   * caller-chosen so URLs are predictable; pass undefined to mint one.
   */
  getOrCreate(
    scenarioName: string,
    id: string | undefined,
    baseUrlFor: (runId: string) => string
  ): HostedRun {
    if (id) {
      const existing = this.runs.get(id);
      if (existing && existing.scenarioName === scenarioName) {
        existing.lastSeenAt = Date.now();
        return existing;
      }
      // Same id reused for a different scenario → replace, don't merge checks.
      if (existing) void this.destroy(id);
    }

    const proto = getScenario(scenarioName);
    if (!proto) throw new UnknownScenarioError(scenarioName);

    const Ctor = proto.constructor as new () => Scenario;
    const scenario = new Ctor();
    const runId = id ?? randomBytes(6).toString('base64url');

    let listener: RequestListener;
    let auxListeners: HostedRun['auxListeners'];
    let context: Record<string, unknown> | undefined;

    if (scenario instanceof AuthHandlerScenario) {
      // Multi-origin scenario: build RS + aux handlers from authHandlers().
      // Aux issuer is <relay-origin>/r/<runId> so the run-id is recoverable
      // from any RFC 8414 well-known path the client constructs from it.
      const missing = scenario.auxRoles.filter((r) => !this.auxOrigins[r]);
      if (missing.length) {
        throw new NotHostableError(
          scenarioName,
          `needs aux origin(s) [${missing.join(', ')}] — start with --as-origin`
        );
      }
      const handlers = scenario.authHandlers({
        getRsBaseUrl: () => baseUrlFor(runId),
        getAuxBaseUrl: (role) => `${this.auxOrigins[role]}/r/${runId}`
      });
      listener = handlers.rs;
      auxListeners = handlers.aux;
      context = (
        scenario as unknown as {
          scenarioContext?: () => Record<string, unknown>;
        }
      ).scenarioContext?.();
    } else if (scenario.handler) {
      listener = scenario.handler(() => baseUrlFor(runId));
    } else {
      throw new NotHostableError(scenarioName);
    }

    const run: HostedRun = {
      id: runId,
      scenarioName,
      scenario,
      listener,
      auxListeners,
      mcpPath: scenario.mcpPath ?? '',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      context
    };
    this.runs.set(runId, run);
    void this.store?.saveRun(runId, scenarioName).catch(logStoreError);
    return run;
  }

  get(id: string): HostedRun | undefined {
    const r = this.runs.get(id);
    if (r) r.lastSeenAt = Date.now();
    return r;
  }

  /**
   * Like get(), but if this process has never seen the run and a store is
   * configured, rebuild it from persisted metadata. This is how an aux-origin
   * request or a results page lands correctly on a cold process.
   */
  async ensure(
    id: string,
    baseUrlFor: (scenarioName: string, runId: string) => string
  ): Promise<HostedRun | undefined> {
    const local = this.get(id);
    if (local || !this.store) return local;
    let scenarioName: string | undefined;
    try {
      scenarioName = await this.store.loadRun(id);
    } catch (e) {
      logStoreError(e);
    }
    if (!scenarioName) return undefined;
    return this.getOrCreate(scenarioName, id, (rid) =>
      baseUrlFor(scenarioName, rid)
    );
  }

  /** Write this process's view of a run's checks through to the store. */
  persist(run: HostedRun): Promise<void> {
    if (!this.store) return Promise.resolve();
    const p = this.store
      .saveChecks(
        run.id,
        this.writerId,
        rawChecksOf(run.scenario).map((c) => ({ ...c }))
      )
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
   * Judged checks for a run. Without a store this is the scenario's own
   * getChecks(). With a store it is every process's raw log merged (this
   * process's live log wins over its own persisted row) and re-judged once.
   */
  async results(id: string): Promise<RunResults | undefined> {
    const run = this.runs.get(id);
    if (!this.store) {
      return run
        ? { scenarioName: run.scenarioName, checks: run.scenario.getChecks() }
        : undefined;
    }
    let byWriter = new Map<string, ConformanceCheck[]>();
    try {
      byWriter = await this.store.loadChecks(id);
    } catch (e) {
      logStoreError(e);
    }
    if (run) byWriter.set(this.writerId, rawChecksOf(run.scenario));
    let scenarioName = run?.scenarioName;
    if (!scenarioName) {
      try {
        scenarioName = await this.store.loadRun(id);
      } catch (e) {
        logStoreError(e);
      }
    }
    if (!scenarioName) return undefined;
    const merged = Array.from(byWriter.values())
      .flat()
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    return { scenarioName, checks: finalizeChecks(scenarioName, merged) };
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
        (why
          ? `: ${why}`
          : ` (no handler() or authHandlers() — typically backcompat scenarios that need root-of-origin endpoints).`)
    );
  }
}

/** Scenarios that can run hosted, partitioned by what they need. */
export function listHostableScenarios(
  withAuxOrigins: readonly AuxOriginRole[] = []
): string[] {
  const have = new Set(withAuxOrigins);
  return Array.from(scenarios.entries())
    .filter(([, s]) => {
      if (typeof s.handler === 'function') return true;
      if (s instanceof AuthHandlerScenario) {
        return s.auxRoles.every((r) => have.has(r));
      }
      return false;
    })
    .map(([name]) => name);
}
