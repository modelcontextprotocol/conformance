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
}

export class SessionManager {
  private runs = new Map<string, HostedRun>();
  private readonly ttlMs: number;
  private readonly auxOrigins: Partial<Record<AuxOriginRole, string>>;
  private sweeper: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.auxOrigins = opts.auxOrigins ?? {};
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
    return run;
  }

  get(id: string): HostedRun | undefined {
    const r = this.runs.get(id);
    if (r) r.lastSeenAt = Date.now();
    return r;
  }

  results(id: string): ConformanceCheck[] | undefined {
    return this.runs.get(id)?.scenario.getChecks();
  }

  list(): HostedRun[] {
    return Array.from(this.runs.values());
  }

  async destroy(id: string): Promise<void> {
    const r = this.runs.get(id);
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
      Array.from(this.runs.keys()).map((id) => this.destroy(id))
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, r] of this.runs) {
      if (now - r.lastSeenAt > this.ttlMs) void this.destroy(id);
    }
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
