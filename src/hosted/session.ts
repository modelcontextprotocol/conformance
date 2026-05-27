/**
 * Session management for the hosted conformance server.
 *
 * A "session" is one isolated run of a scenario. Each session owns its own
 * Scenario instance (and therefore its own underlying http.Server bound to a
 * loopback port). The hosted server proxies path-prefixed requests to that
 * port and harvests checks via getChecks().
 *
 * Sessions are keyed by a short id (also surfaced as mcp-session-id) so a
 * client can hit a stable scenario URL like /s/initialize and still get
 * isolated results at /results/<id>.
 */

import { randomBytes } from 'crypto';
import { Scenario, ConformanceCheck } from '../types';
import { getScenario, listScenarios } from '../scenarios';

export interface HostedSession {
  id: string;
  scenarioName: string;
  scenario: Scenario;
  /** Loopback URL the scenario is listening on (e.g. http://localhost:54321/mcp) */
  targetUrl: URL;
  createdAt: number;
  lastSeenAt: number;
  /** Optional context the scenario wants delivered to the client */
  context?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  /** Idle ms after which a session is reaped. Default 5 minutes. */
  ttlMs?: number;
  /** How often to sweep for expired sessions. Default 30s. */
  sweepIntervalMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, HostedSession>();
  private readonly ttlMs: number;
  private sweeper: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep the process alive just for the sweeper.
    this.sweeper.unref?.();
  }

  /** Create a fresh scenario instance and start it on a loopback port. */
  async create(scenarioName: string): Promise<HostedSession> {
    const factory = getScenario(scenarioName);
    if (!factory) {
      throw new UnknownScenarioError(scenarioName);
    }
    // Each call to getScenario returns the same singleton, so re-instantiate
    // via its constructor to get isolated state.
    const ScenarioCtor = factory.constructor as new () => Scenario;
    const scenario = new ScenarioCtor();

    const urls = await scenario.start();
    const id = randomBytes(6).toString('base64url');
    const session: HostedSession = {
      id,
      scenarioName,
      scenario,
      targetUrl: new URL(urls.serverUrl),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      context: urls.context
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): HostedSession | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
    return s;
  }

  list(): HostedSession[] {
    return Array.from(this.sessions.values());
  }

  results(id: string): ConformanceCheck[] | undefined {
    const s = this.sessions.get(id);
    return s?.scenario.getChecks();
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      await s.scenario.stop();
    } catch {
      // best-effort; the loopback server may already be gone
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all(
      Array.from(this.sessions.keys()).map((id) => this.destroy(id))
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > this.ttlMs) {
        void this.destroy(id);
      }
    }
  }
}

export class UnknownScenarioError extends Error {
  constructor(name: string) {
    super(
      `Unknown scenario '${name}'. Available: ${listScenarios().join(', ')}`
    );
  }
}

/**
 * Scenarios that the hosted runner can serve via path-proxy.
 *
 * Excluded: scenarios whose ScenarioUrls.authUrl is set (they spin up a
 * second auth server on another port that the client must reach directly,
 * which a single-origin proxy can't expose) and scenarios that depend on
 * the runner spawning the client process.
 */
export function listHostableScenarios(): string[] {
  return listScenarios().filter((name) => {
    const s = getScenario(name);
    // No good static way to know if authUrl will be set without starting it,
    // so use the naming convention all auth scenarios share.
    return s !== undefined && !name.startsWith('auth/');
  });
}
