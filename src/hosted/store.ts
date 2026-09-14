/**
 * Run persistence for the hosted conformance server.
 *
 * A long-lived Node process keeps every run in memory and needs none of this.
 * Serverless hosts (val.town, Deno Deploy, …) load-balance one run's requests
 * across short-lived isolates, so the isolate that answers GET /results is
 * often not the one that saw the MCP traffic. A RunStore lets each isolate
 * write through what it observed and lets any isolate serve a merged view:
 *
 *   - run metadata (cell id → scenario) so the results page can list which
 *     cells of a run were exercised, and tear them all down together;
 *   - checks, keyed by (run, writer): each isolate owns its own row and
 *     replaces it wholesale after every request, so concurrent writers never
 *     clobber each other and no append ordering is needed. The hosted
 *     layer's own checks (client identity, probe notes) go to a row per
 *     build of the cell in the isolate, so a cell evicted from memory and
 *     rebuilt does not write over what it recorded before.
 *
 * The merged log is re-judged at results time by a fresh scenario instance
 * (see SessionManager.results), which is what turns "isolate B never saw a
 * tools/call" from a false FAILURE into the union of what A and B saw.
 *
 * It also keeps snapshots: a run's report frozen at one moment (POST
 * /results/<run-id>/freeze), stored as its JSON so any isolate can serve
 * the permalink and later traffic cannot change it.
 */

import type { ConformanceCheck } from '../types';

export interface SnapshotInfo {
  id: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** How long a store keeps what it holds, as the landing page states it. */
export interface StoreRetention {
  /** A cell's recorded traffic, counted from the cell's first request. */
  runMs: number;
  /** A frozen report, counted from when it was frozen. */
  snapshotMs: number;
}

export interface RunStore {
  /** Set by a store that deletes old runs and snapshots by itself. */
  readonly retention?: StoreRetention;
  saveRun(id: string, scenarioName: string): Promise<void>;
  /** Scenario name for a run id, or undefined if no isolate ever saw it. */
  loadRun(id: string): Promise<string | undefined>;
  /**
   * Every saved run whose id starts with `prefix`. Cell ids are
   * `<run-id>/<revision>/<scenario>`, so `<run-id>/` lists one run's cells.
   */
  listRuns(
    prefix: string
  ): Promise<Array<{ id: string; scenarioName: string }>>;
  saveChecks(
    id: string,
    writer: string,
    checks: ConformanceCheck[]
  ): Promise<void>;
  /** All writers' check lists for a run, keyed by writer id. */
  loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>>;
  deleteRun(id: string): Promise<void>;
  /**
   * Keep a run's frozen report. `body` is its JSON, stored as given; a
   * snapshot id already taken keeps its first body.
   */
  saveSnapshot(runId: string, snapshotId: string, body: string): Promise<void>;
  loadSnapshot(runId: string, snapshotId: string): Promise<string | undefined>;
  /** A run's snapshots, oldest first. */
  listSnapshots(runId: string): Promise<SnapshotInfo[]>;
  deleteSnapshots(runId: string): Promise<void>;
  /**
   * Note that cell `id` answered a request from `requester` with a sign-in
   * challenge (401) at `at` (ms since the epoch), replacing that pair's
   * earlier note. `requester` is a keyed hash of the client's address, ''
   * when it is unknown (see requesterHasher() in ./root-prm.ts). A request
   * that names no cell (the origin-root protected resource metadata) is
   * attributed from the notes of its own requester, whichever process sent
   * the challenge. A store may drop notes after an hour.
   */
  saveChallenge(id: string, requester: string, at: number): Promise<void>;
  /**
   * Cells whose latest challenge to `requester` is at or after `since`,
   * latest first. Never another requester's cells.
   */
  listChallenges(
    since: number,
    requester: string
  ): Promise<Array<{ id: string; at: number }>>;
}

/** How long a store must keep a challenge note (see saveChallenge()). */
export const CHALLENGE_RETENTION_MS = 3600_000;

/**
 * In-process store — used by tests to exercise the merge path, and by a
 * single long-lived process for its snapshots.
 */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, string>();
  private checks = new Map<string, Map<string, ConformanceCheck[]>>();
  private snapshots = new Map<
    string,
    Map<string, { body: string; createdAt: number }>
  >();

  async saveRun(id: string, scenarioName: string): Promise<void> {
    if (!this.runs.has(id)) this.runs.set(id, scenarioName);
  }
  async loadRun(id: string): Promise<string | undefined> {
    return this.runs.get(id);
  }
  async listRuns(
    prefix: string
  ): Promise<Array<{ id: string; scenarioName: string }>> {
    return Array.from(this.runs.entries())
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, scenarioName]) => ({ id, scenarioName }));
  }
  async saveChecks(
    id: string,
    writer: string,
    checks: ConformanceCheck[]
  ): Promise<void> {
    let byWriter = this.checks.get(id);
    if (!byWriter) this.checks.set(id, (byWriter = new Map()));
    byWriter.set(
      writer,
      checks.map((c) => ({ ...c }))
    );
  }
  async loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>> {
    return new Map(this.checks.get(id) ?? []);
  }
  async deleteRun(id: string): Promise<void> {
    this.runs.delete(id);
    this.checks.delete(id);
  }
  async saveSnapshot(
    runId: string,
    snapshotId: string,
    body: string
  ): Promise<void> {
    let byId = this.snapshots.get(runId);
    if (!byId) this.snapshots.set(runId, (byId = new Map()));
    if (!byId.has(snapshotId)) {
      byId.set(snapshotId, { body, createdAt: Date.now() });
    }
  }
  async loadSnapshot(
    runId: string,
    snapshotId: string
  ): Promise<string | undefined> {
    return this.snapshots.get(runId)?.get(snapshotId)?.body;
  }
  async listSnapshots(runId: string): Promise<SnapshotInfo[]> {
    return Array.from(this.snapshots.get(runId) ?? [], ([id, s]) => ({
      id,
      createdAt: s.createdAt
    }));
  }
  async deleteSnapshots(runId: string): Promise<void> {
    this.snapshots.delete(runId);
  }
  /** Keyed by requester and cell id (a requester hash has no space). */
  private challenges = new Map<
    string,
    { id: string; requester: string; at: number }
  >();
  async saveChallenge(
    id: string,
    requester: string,
    at: number
  ): Promise<void> {
    for (const [key, c] of this.challenges) {
      if (c.at < at - CHALLENGE_RETENTION_MS) this.challenges.delete(key);
    }
    this.challenges.set(`${requester} ${id}`, { id, requester, at });
  }
  async listChallenges(
    since: number,
    requester: string
  ): Promise<Array<{ id: string; at: number }>> {
    return Array.from(this.challenges.values())
      .filter((c) => c.requester === requester && c.at >= since)
      .sort((a, b) => b.at - a.at)
      .map(({ id, at }) => ({ id, at }));
  }
}
