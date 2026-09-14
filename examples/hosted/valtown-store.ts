/**
 * RunStore backed by val.town's per-account SQLite (REST API).
 *
 * val.town injects an API token into every val as the `valtown` env var; the
 * SQLite API is `POST /v1/sqlite/execute {statement:{sql,args}}`. Two tables
 * for runs, created the first time a statement on them fails (so a cold
 * isolate does not spend two round trips making sure), and a third for
 * frozen reports, created the first time an isolate touches one. A cell's
 * attempts and traffic have a table each, created the first time a
 * statement on it fails. Old runs (with their attempts and traffic) are
 * swept on new-run creation and old snapshots on new-snapshot creation,
 * throttled per isolate, so the database stays bounded without a cron.
 */

import type { ConformanceCheck } from '../../src/types';
import {
  CHALLENGE_RETENTION_MS,
  type RunStore,
  type SnapshotInfo,
  type StoreRetention
} from '../../src/hosted/store';
import { TRAFFIC_CELL_BYTES, type TrafficRow } from '../../src/hosted/traffic';

const API = 'https://api.val.town/v1/sqlite/execute';

/** Default run retention (`CONFORMANCE_RUN_RETENTION_MS`): 6 hours. */
export const DEFAULT_RUN_RETENTION_MS = 6 * 3600_000;
/**
 * Default snapshot retention (`CONFORMANCE_SNAPSHOT_RETENTION_MS`): 30 days,
 * long enough for a permalink pasted into an issue to stay useful.
 */
export const DEFAULT_SNAPSHOT_RETENTION_MS = 30 * 24 * 3600_000;

export interface SqliteRunStoreOptions {
  token?: string;
  /**
   * A cell's rows are swept this long after its first request. Default
   * DEFAULT_RUN_RETENTION_MS.
   */
  retentionMs?: number;
  /**
   * Snapshots older than this are swept. Default
   * DEFAULT_SNAPSHOT_RETENTION_MS.
   */
  snapshotRetentionMs?: number;
  /** Cap on checks persisted per (run, writer). Default 1000. */
  maxChecks?: number;
}

type Row = unknown[];

export class SqliteRunStore implements RunStore {
  private readonly token: string;
  private readonly retentionMs: number;
  private readonly snapshotRetentionMs: number;
  private readonly maxChecks: number;
  private ready: Promise<void> | undefined;
  private snapshotsReady: Promise<void> | undefined;
  private lastSweep = 0;
  private lastSnapshotSweep = 0;
  private lastChallengeSweep = 0;

  constructor(opts: SqliteRunStoreOptions = {}) {
    const token = opts.token ?? process.env.valtown;
    if (!token)
      throw new Error('SqliteRunStore: no val.town token (env valtown)');
    this.token = token;
    this.retentionMs =
      opts.retentionMs ??
      Number(
        process.env.CONFORMANCE_RUN_RETENTION_MS ?? DEFAULT_RUN_RETENTION_MS
      );
    this.snapshotRetentionMs =
      opts.snapshotRetentionMs ??
      Number(
        process.env.CONFORMANCE_SNAPSHOT_RETENTION_MS ??
          DEFAULT_SNAPSHOT_RETENTION_MS
      );
    this.maxChecks = opts.maxChecks ?? 1000;
  }

  /** What the landing page tells people, from the values in force. */
  get retention(): StoreRetention {
    return { runMs: this.retentionMs, snapshotMs: this.snapshotRetentionMs };
  }

  private async exec(sql: string, args: unknown[] = []): Promise<Row[]> {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ statement: { sql, args } })
    });
    if (!res.ok) {
      throw new Error(
        `sqlite ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
    }
    const body = (await res.json()) as { rows?: Row[] };
    return body.rows ?? [];
  }

  /**
   * A statement on the runs tables. They exist but for a fresh account, so
   * it is sent at once; only if it fails are the tables created and the
   * statement sent again. A cold isolate's first write is one round trip,
   * not three.
   */
  private async execRuns(sql: string, args: unknown[] = []): Promise<Row[]> {
    if (this.ready) {
      await this.ready;
      return this.exec(sql, args);
    }
    try {
      return await this.exec(sql, args);
    } catch {
      await this.init();
      return this.exec(sql, args);
    }
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.exec(
        `CREATE TABLE IF NOT EXISTS hosted_runs_v2 (
           id TEXT PRIMARY KEY, scenario TEXT NOT NULL, created_at INTEGER NOT NULL)`
      );
      await this.exec(
        `CREATE TABLE IF NOT EXISTS hosted_checks_v2 (
           run_id TEXT NOT NULL, writer TEXT NOT NULL, checks TEXT NOT NULL,
           updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, writer))`
      );
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async saveRun(id: string, scenarioName: string): Promise<void> {
    await this.execRuns(
      `INSERT INTO hosted_runs_v2 (id, scenario, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET scenario = excluded.scenario`,
      [id, scenarioName, Date.now()]
    );
    void this.sweep().catch(() => {});
  }

  async loadRun(id: string): Promise<string | undefined> {
    const rows = await this.execRuns(
      `SELECT scenario FROM hosted_runs_v2 WHERE id = ?`,
      [id]
    );
    return rows[0]?.[0] as string | undefined;
  }

  async listRuns(
    prefix: string
  ): Promise<Array<{ id: string; scenarioName: string }>> {
    // LIKE treats % and _ as wildcards; escape them (and the escape char) so
    // the prefix matches literally.
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    const rows = await this.execRuns(
      `SELECT id, scenario FROM hosted_runs_v2 WHERE id LIKE ? ESCAPE '\\'`,
      [like]
    );
    return rows.map(([id, scenario]) => ({
      id: id as string,
      scenarioName: scenario as string
    }));
  }

  async saveChecks(
    id: string,
    writer: string,
    checks: ConformanceCheck[]
  ): Promise<void> {
    await this.execRuns(
      `INSERT INTO hosted_checks_v2 (run_id, writer, checks, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, writer) DO UPDATE
         SET checks = excluded.checks, updated_at = excluded.updated_at`,
      [id, writer, JSON.stringify(checks.slice(-this.maxChecks)), Date.now()]
    );
  }

  async loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>> {
    const rows = await this.execRuns(
      `SELECT writer, checks FROM hosted_checks_v2 WHERE run_id = ?`,
      [id]
    );
    const out = new Map<string, ConformanceCheck[]>();
    for (const [writer, checks] of rows) {
      try {
        out.set(writer as string, JSON.parse(checks as string));
      } catch {
        // corrupt row — ignore
      }
    }
    return out;
  }

  async deleteRun(id: string): Promise<void> {
    await this.execRuns(`DELETE FROM hosted_checks_v2 WHERE run_id = ?`, [id]);
    await this.execCell(`DELETE FROM hosted_traffic_v1 WHERE cell_id = ?`, [
      id
    ]);
    await this.execCell(`DELETE FROM hosted_attempts_v1 WHERE cell_id = ?`, [
      id
    ]);
    await this.execRuns(`DELETE FROM hosted_runs_v2 WHERE id = ?`, [id]);
  }

  /**
   * A statement on a cell's attempts or traffic. Their tables are created
   * the first time a statement on them fails, as the challenge notes' are.
   */
  private async execCell(sql: string, args: unknown[]): Promise<Row[]> {
    try {
      return await this.exec(sql, args);
    } catch {
      await this.exec(
        `CREATE TABLE IF NOT EXISTS hosted_attempts_v1 (
           cell_id TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL,
           PRIMARY KEY (cell_id, n))`
      );
      await this.exec(
        `CREATE TABLE IF NOT EXISTS hosted_traffic_v1 (
           cell_id TEXT NOT NULL, writer TEXT NOT NULL, row TEXT NOT NULL,
           updated_at INTEGER NOT NULL, PRIMARY KEY (cell_id, writer))`
      );
      return this.exec(sql, args);
    }
  }

  async startAttempt(id: string, at: number): Promise<number> {
    const rows = await this.execCell(
      `INSERT INTO hosted_attempts_v1 (cell_id, n, at)
       SELECT ?, COALESCE(MAX(n), 1) + 1, ? FROM hosted_attempts_v1 WHERE cell_id = ?
       ON CONFLICT(cell_id, n) DO NOTHING
       RETURNING n`,
      [id, at, id]
    );
    if (rows[0]?.[0] !== undefined) return Number(rows[0][0]);
    // Another reset took that number at the same moment: one attempt.
    return (await this.loadAttempts(id)).length + 1;
  }

  async loadAttempts(id: string): Promise<number[]> {
    const rows = await this.execCell(
      `SELECT at FROM hosted_attempts_v1 WHERE cell_id = ? ORDER BY n`,
      [id]
    );
    return rows.map(([at]) => Number(at));
  }

  async saveTraffic(
    id: string,
    writer: string,
    row: TrafficRow
  ): Promise<void> {
    const json = JSON.stringify(row);
    // Kept only while the cell's rows, this one included, stay under the cap.
    await this.execCell(
      `INSERT INTO hosted_traffic_v1 (cell_id, writer, row, updated_at)
       SELECT ?, ?, ?, ? WHERE
         (SELECT COALESCE(SUM(LENGTH(row)), 0) FROM hosted_traffic_v1
           WHERE cell_id = ? AND writer <> ?) + ? <= ?
       ON CONFLICT(cell_id, writer) DO UPDATE
         SET row = excluded.row, updated_at = excluded.updated_at`,
      [
        id,
        writer,
        json,
        Date.now(),
        id,
        writer,
        json.length,
        TRAFFIC_CELL_BYTES
      ]
    );
  }

  async loadTraffic(id: string): Promise<Map<string, TrafficRow>> {
    const rows = await this.execCell(
      `SELECT writer, row FROM hosted_traffic_v1 WHERE cell_id = ?`,
      [id]
    );
    const out = new Map<string, TrafficRow>();
    for (const [writer, row] of rows) {
      try {
        out.set(writer as string, JSON.parse(row as string) as TrafficRow);
      } catch {
        // corrupt row — ignore
      }
    }
    return out;
  }

  private initSnapshots(): Promise<void> {
    this.snapshotsReady ??= this.exec(
      `CREATE TABLE IF NOT EXISTS hosted_snapshots_v1 (
         run_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
         created_at INTEGER NOT NULL, PRIMARY KEY (run_id, id))`
    )
      .then(() => undefined)
      .catch((e) => {
        this.snapshotsReady = undefined;
        throw e;
      });
    return this.snapshotsReady;
  }

  async saveSnapshot(
    runId: string,
    snapshotId: string,
    body: string
  ): Promise<void> {
    await this.initSnapshots();
    await this.exec(
      `INSERT INTO hosted_snapshots_v1 (run_id, id, body, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(run_id, id) DO NOTHING`,
      [runId, snapshotId, body, Date.now()]
    );
    void this.sweepSnapshots().catch(() => {});
  }

  async loadSnapshot(
    runId: string,
    snapshotId: string
  ): Promise<string | undefined> {
    await this.initSnapshots();
    const rows = await this.exec(
      `SELECT body FROM hosted_snapshots_v1 WHERE run_id = ? AND id = ?`,
      [runId, snapshotId]
    );
    return rows[0]?.[0] as string | undefined;
  }

  async listSnapshots(runId: string): Promise<SnapshotInfo[]> {
    await this.initSnapshots();
    const rows = await this.exec(
      `SELECT id, created_at FROM hosted_snapshots_v1 WHERE run_id = ?
       ORDER BY created_at`,
      [runId]
    );
    return rows.map(([id, createdAt]) => ({
      id: id as string,
      createdAt: Number(createdAt)
    }));
  }

  async deleteSnapshots(runId: string): Promise<void> {
    await this.initSnapshots();
    await this.exec(`DELETE FROM hosted_snapshots_v1 WHERE run_id = ?`, [
      runId
    ]);
  }

  /**
   * A statement on the challenge notes, whose table is created the first
   * time a statement on it fails, as the runs tables are (see execRuns()).
   * Each note carries its requester, a keyed hash of the client's address
   * (never the address); the v1 table, which had none, is no longer read.
   */
  private async execChallenges(sql: string, args: unknown[]): Promise<Row[]> {
    try {
      return await this.exec(sql, args);
    } catch {
      await this.exec(
        `CREATE TABLE IF NOT EXISTS hosted_challenges_v2 (
           cell_id TEXT NOT NULL, requester TEXT NOT NULL, at INTEGER NOT NULL,
           PRIMARY KEY (cell_id, requester))`
      );
      return this.exec(sql, args);
    }
  }

  async saveChallenge(
    id: string,
    requester: string,
    at: number
  ): Promise<void> {
    await this.execChallenges(
      `INSERT INTO hosted_challenges_v2 (cell_id, requester, at) VALUES (?, ?, ?)
       ON CONFLICT(cell_id, requester) DO UPDATE SET at = excluded.at`,
      [id, requester, at]
    );
    const now = Date.now();
    if (now - this.lastChallengeSweep < 5 * 60_000) return;
    this.lastChallengeSweep = now;
    void this.exec(`DELETE FROM hosted_challenges_v2 WHERE at < ?`, [
      now - CHALLENGE_RETENTION_MS
    ]).catch(() => {});
  }

  async listChallenges(
    since: number,
    requester: string
  ): Promise<Array<{ id: string; at: number }>> {
    const rows = await this.execChallenges(
      `SELECT cell_id, at FROM hosted_challenges_v2
       WHERE requester = ? AND at >= ? ORDER BY at DESC LIMIT 20`,
      [requester, since]
    );
    return rows.map(([id, at]) => ({ id: id as string, at: Number(at) }));
  }

  private async sweepSnapshots(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSnapshotSweep < 5 * 60_000) return;
    this.lastSnapshotSweep = now;
    await this.exec(`DELETE FROM hosted_snapshots_v1 WHERE created_at < ?`, [
      now - this.snapshotRetentionMs
    ]);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = now;
    const cutoff = now - this.retentionMs;
    await this.exec(
      `DELETE FROM hosted_checks_v2 WHERE run_id IN
         (SELECT id FROM hosted_runs_v2 WHERE created_at < ?)`,
      [cutoff]
    );
    for (const table of ['hosted_traffic_v1', 'hosted_attempts_v1']) {
      await this.execCell(
        `DELETE FROM ${table} WHERE cell_id IN
           (SELECT id FROM hosted_runs_v2 WHERE created_at < ?)`,
        [cutoff]
      );
    }
    await this.exec(`DELETE FROM hosted_runs_v2 WHERE created_at < ?`, [
      cutoff
    ]);
  }
}
