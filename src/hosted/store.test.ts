import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRunStore } from './store';
import { SqliteRunStore } from '../../examples/hosted/valtown-store';

describe('MemoryRunStore', () => {
  it('lists the cells of one run by id prefix', async () => {
    const store = new MemoryRunStore();
    await store.saveRun('r1/2025-11-25/tools_call', 'tools_call');
    await store.saveRun('r1/2026-07-28/auth/basic-cimd', 'auth/basic-cimd');
    await store.saveRun('r10/2025-11-25/tools_call', 'tools_call');
    expect((await store.listRuns('r1/')).map((r) => r.id).sort()).toEqual([
      'r1/2025-11-25/tools_call',
      'r1/2026-07-28/auth/basic-cimd'
    ]);
    expect(await store.listRuns('r1/')).toContainEqual({
      id: 'r1/2026-07-28/auth/basic-cimd',
      scenarioName: 'auth/basic-cimd'
    });
    expect(await store.listRuns('nope/')).toEqual([]);
  });

  it('keeps each snapshot as first saved, lists them oldest first, deletes per run', async () => {
    const store = new MemoryRunStore();
    await store.saveSnapshot('r1', 'a', '{"v":1}');
    await store.saveSnapshot('r1', 'a', '{"v":2}'); // frozen: first body wins
    await store.saveSnapshot('r1', 'b', '{"v":3}');
    await store.saveSnapshot('r2', 'a', '{}');
    expect(await store.loadSnapshot('r1', 'a')).toBe('{"v":1}');
    expect(await store.loadSnapshot('r1', 'zz')).toBeUndefined();
    expect((await store.listSnapshots('r1')).map((s) => s.id)).toEqual([
      'a',
      'b'
    ]);
    await store.deleteSnapshots('r1');
    expect(await store.listSnapshots('r1')).toEqual([]);
    expect(await store.loadSnapshot('r2', 'a')).toBe('{}');
  });
});

describe('SqliteRunStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists by prefix with LIKE, escaping the wildcard characters', async () => {
    const statements: { sql: string; args: unknown[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { statement } = JSON.parse(init.body);
        statements.push(statement);
        const rows = statement.sql.includes('SELECT id, scenario')
          ? [['r_1/2025-11-25/tools_call', 'tools_call']]
          : [];
        return new Response(JSON.stringify({ rows }), { status: 200 });
      })
    );
    const store = new SqliteRunStore({ token: 't' });
    const listed = await store.listRuns('r_1%/');
    expect(listed).toEqual([
      { id: 'r_1/2025-11-25/tools_call', scenarioName: 'tools_call' }
    ]);
    const select = statements.find((s) =>
      s.sql.includes('SELECT id, scenario')
    )!;
    expect(select.sql).toContain("WHERE id LIKE ? ESCAPE '\\'");
    expect(select.args).toEqual(['r\\_1\\%/%']);
  });

  it('writes in one round trip, creating the tables only when a write fails', async () => {
    const statements: string[] = [];
    let tables = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { sql } = JSON.parse(init.body).statement as { sql: string };
        statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (sql.includes('CREATE TABLE')) tables = true;
        else if (!tables)
          return new Response('no such table: hosted_runs_v2', {
            status: 400
          });
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      })
    );
    const warm = new SqliteRunStore({ token: 't' });
    await warm.saveChecks('r1/2026-07-28/tools_call', 'w', []);
    expect(statements).toEqual(['INSERT INTO hosted_checks_v2']);

    // A fresh account: the write fails, the tables are made, it is retried.
    statements.length = 0;
    tables = false;
    const fresh = new SqliteRunStore({ token: 't' });
    await fresh.saveChecks('r1/2026-07-28/tools_call', 'w', []);
    await fresh.saveChecks('r1/2026-07-28/tools_call', 'w', []);
    expect(statements).toEqual([
      'INSERT INTO hosted_checks_v2',
      'CREATE TABLE IF',
      'CREATE TABLE IF',
      'INSERT INTO hosted_checks_v2',
      'INSERT INTO hosted_checks_v2'
    ]);
  });

  it('stores snapshots in their own table, first body kept', async () => {
    const statements: { sql: string; args: unknown[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { statement } = JSON.parse(init.body);
        statements.push(statement);
        const rows = statement.sql.includes('SELECT body')
          ? [['{"runId":"r1"}']]
          : statement.sql.includes('SELECT id, created_at')
            ? [['s1', 5]]
            : [];
        return new Response(JSON.stringify({ rows }), { status: 200 });
      })
    );
    const store = new SqliteRunStore({ token: 't' });
    await store.saveSnapshot('r1', 's1', '{"runId":"r1"}');
    expect(await store.loadSnapshot('r1', 's1')).toBe('{"runId":"r1"}');
    expect(await store.listSnapshots('r1')).toEqual([
      { id: 's1', createdAt: 5 }
    ]);
    await store.deleteSnapshots('r1');

    const creates = statements.filter((s) =>
      s.sql.includes('CREATE TABLE IF NOT EXISTS hosted_snapshots_v1')
    );
    expect(creates).toHaveLength(1); // once per isolate
    const insert = statements.find((s) =>
      s.sql.includes('INSERT INTO hosted_snapshots_v1')
    )!;
    expect(insert.sql).toContain('ON CONFLICT(run_id, id) DO NOTHING');
    expect(insert.args.slice(0, 3)).toEqual(['r1', 's1', '{"runId":"r1"}']);
    expect(
      statements.some((s) =>
        s.sql.includes('DELETE FROM hosted_snapshots_v1 WHERE run_id = ?')
      )
    ).toBe(true);
  });
});
