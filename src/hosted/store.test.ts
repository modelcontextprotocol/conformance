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
});
