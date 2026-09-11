/**
 * RunStore backed by val.town's per-account SQLite (REST API).
 *
 * val.town injects an API token into every val as the `valtown` env var; the
 * SQLite API is `POST /v1/sqlite/execute {statement:{sql,args}}`. Two tables,
 * created lazily once per isolate. Old runs are swept on new-run creation,
 * throttled per isolate, so the database stays bounded without a cron.
 */

import type { ConformanceCheck } from '../../src/types';
import type { RunStore } from '../../src/hosted/store';

const API = 'https://api.val.town/v1/sqlite/execute';

export interface SqliteRunStoreOptions {
  token?: string;
  /** Runs older than this are swept. Default 6h. */
  retentionMs?: number;
  /** Cap on checks persisted per (run, writer). Default 1000. */
  maxChecks?: number;
}

type Row = unknown[];

export class SqliteRunStore implements RunStore {
  private readonly token: string;
  private readonly retentionMs: number;
  private readonly maxChecks: number;
  private ready: Promise<void> | undefined;
  private lastSweep = 0;

  constructor(opts: SqliteRunStoreOptions = {}) {
    const token = opts.token ?? process.env.valtown;
    if (!token)
      throw new Error('SqliteRunStore: no val.town token (env valtown)');
    this.token = token;
    this.retentionMs =
      opts.retentionMs ??
      Number(process.env.CONFORMANCE_RUN_RETENTION_MS ?? 6 * 3600_000);
    this.maxChecks = opts.maxChecks ?? 1000;
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
    await this.init();
    await this.exec(
      `INSERT INTO hosted_runs_v2 (id, scenario, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET scenario = excluded.scenario`,
      [id, scenarioName, Date.now()]
    );
    void this.sweep().catch(() => {});
  }

  async loadRun(id: string): Promise<string | undefined> {
    await this.init();
    const rows = await this.exec(
      `SELECT scenario FROM hosted_runs_v2 WHERE id = ?`,
      [id]
    );
    return rows[0]?.[0] as string | undefined;
  }

  async listRuns(
    prefix: string
  ): Promise<Array<{ id: string; scenarioName: string }>> {
    await this.init();
    // LIKE treats % and _ as wildcards; escape them (and the escape char) so
    // the prefix matches literally.
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    const rows = await this.exec(
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
    await this.init();
    await this.exec(
      `INSERT INTO hosted_checks_v2 (run_id, writer, checks, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, writer) DO UPDATE
         SET checks = excluded.checks, updated_at = excluded.updated_at`,
      [id, writer, JSON.stringify(checks.slice(-this.maxChecks)), Date.now()]
    );
  }

  async loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>> {
    await this.init();
    const rows = await this.exec(
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
    await this.init();
    await this.exec(`DELETE FROM hosted_checks_v2 WHERE run_id = ?`, [id]);
    await this.exec(`DELETE FROM hosted_runs_v2 WHERE id = ?`, [id]);
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
    await this.exec(`DELETE FROM hosted_runs_v2 WHERE created_at < ?`, [
      cutoff
    ]);
  }
}
