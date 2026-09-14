import { beforeAll, describe, it, expect } from 'vitest';
import http from 'http';
import {
  SessionManager,
  cellId,
  loadAllCells,
  rawChecksOf,
  type CellRef,
  type HostedRun
} from './session';
import { MemoryRunStore } from './store';
import type { ConformanceCheck, RequestListener } from '../types';
import { ALL_SPEC_VERSIONS } from '../scenarios/applicability';

// Cells built without the HTTP layer, which loads what a request needs.
beforeAll(() => loadAllCells(ALL_SPEC_VERSIONS));

const ref: CellRef = {
  runId: 'r1',
  revision: '2025-11-25',
  scenarioName: 'tools_call'
};

describe('SessionManager.persist', () => {
  it('retries saveRun after a failed write so the cell reaches listRuns', async () => {
    let failures = 0;
    let saveRunCalls = 0;
    class FlakyStore extends MemoryRunStore {
      override async saveRun(id: string, scenarioName: string) {
        saveRunCalls++;
        if (failures-- > 0) throw new Error('sqlite 503');
        return super.saveRun(id, scenarioName);
      }
    }
    const store = new FlakyStore();
    const sessions = new SessionManager({ store });
    try {
      // One refusal is made good within the same write.
      failures = 1;
      const once = sessions.getOrCreate(
        { ...ref, runId: 'r0' },
        () => 'http://rs.test/s/x'
      );
      await sessions.persist(once);
      expect(once.saved).toBe(true);
      expect(saveRunCalls).toBe(2);

      // A write whose every attempt is refused leaves the cell for the next.
      failures = 3;
      saveRunCalls = 0;
      const run = sessions.getOrCreate(ref, () => 'http://rs.test/s/x');
      await sessions.persist(run); // saveRun rejects; the error is logged
      expect(run.saved).toBe(false);
      expect(await store.listRuns('r1/')).toEqual([]);

      await sessions.persist(run);
      expect(run.saved).toBe(true);
      expect(await store.listRuns('r1/')).toEqual([
        { id: 'r1/2025-11-25/tools_call', scenarioName: 'tools_call' }
      ]);

      await sessions.persist(run);
      expect(saveRunCalls).toBe(4);
    } finally {
      await sessions.close();
    }
  });
});

/** POST one JSON-RPC request straight at a cell's listener. */
async function post(
  listener: RequestListener,
  body: object,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  const server = http.createServer(listener);
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://localhost:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('SessionManager hydration', () => {
  const cold: CellRef = {
    runId: 'h1',
    revision: '2026-07-28',
    scenarioName: 'request-metadata'
  };
  const RETRY = 'sep-2575-client-retry-supported-version';
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
  const headers = { 'mcp-protocol-version': '2026-07-28' };

  it('seeds a cold process from the persisted log and persists only what it adds', async () => {
    const store = new MemoryRunStore();
    const a = new SessionManager({ store });
    const b = new SessionManager({ store });
    try {
      // Process A sees the first request: the one simulated rejection.
      const runA = await a.acquire(cold, () => 'http://x');
      const first = await post(runA.listener, request, headers);
      expect(first.status).toBe(400);
      expect(first.body.error.code).toBe(-32022);
      await a.persist(runA);
      const rowA = (await store.loadChecks(cellId(cold))).get(a.writerId)!;
      expect(rowA.map((c) => c.id)).toContain(RETRY);

      // Process B has never seen the cell. Hydrated, it knows the rejection
      // already happened and answers the retry instead of rejecting again.
      const runB: HostedRun = await b.acquire(cold, () => 'http://x');
      expect(runB.seeded.size).toBe(rowA.length);
      expect(rawChecksOf(runB.scenario).map((c) => c.id)).toContain(RETRY);
      // Seeded checks are A's to persist: B owns nothing yet.
      expect(b.ownChecks(runB)).toEqual([]);
      const second = await post(runB.listener, request, headers);
      expect(second.status).toBe(200);

      // B's row carries its own observations only — here every id, since
      // the scenario re-emits each one per request, with the retry check
      // rewritten to SUCCESS.
      await b.persist(runB);
      const rowB = (await store.loadChecks(cellId(cold))).get(b.writerId)!;
      expect(rowB).toEqual(b.ownChecks(runB));
      expect(rowB.find((c) => c.id === RETRY)?.status).toBe('SUCCESS');
      expect(rowA.find((c) => c.id === RETRY)?.status).toBe('WARNING');

      // Judged from the merged log by either process: one retry check, the
      // latest observation, and nothing declared missing.
      for (const m of [a, b]) {
        const results = (await m.results(cellId(cold)))!;
        const retries = results.checks.filter((c) => c.id === RETRY);
        expect(retries).toHaveLength(1);
        expect(retries[0].status).toBe('SUCCESS');
        expect(results.checks.filter((c) => c.status === 'FAILURE')).toEqual(
          []
        );
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('reloads its own evicted row as its own, and settles at once without a store', async () => {
    const store = new MemoryRunStore();
    const a = new SessionManager({ store });
    try {
      const run = await a.acquire(cold, () => 'http://x');
      await post(run.listener, request, headers);
      await a.persist(run);
      const before = (await store.loadChecks(cellId(cold))).get(a.writerId)!;
      expect(before.length).toBeGreaterThan(0);

      // Evicted from memory, rebuilt on the next request: the row it wrote
      // is not "seeded" — it stays in the row on the next persist.
      await a.destroy(cellId(cold), false);
      const again = await a.acquire(cold, () => 'http://x');
      expect(again.seeded.size).toBe(0);
      expect(rawChecksOf(again.scenario)).toHaveLength(before.length);
      await a.persist(again);
      expect((await store.loadChecks(cellId(cold))).get(a.writerId)).toEqual(
        before
      );
    } finally {
      await a.close();
    }

    const plain = new SessionManager();
    try {
      const run = await plain.acquire(cold, () => 'http://x');
      expect(rawChecksOf(run.scenario)).toEqual([]);
      expect(run.hydration).toBeDefined();
    } finally {
      await plain.close();
    }
  });

  it('keeps the hosted checks of an evicted build when the rebuilt one writes', async () => {
    const store = new MemoryRunStore();
    const a = new SessionManager({ store });
    const note = (key: string): ConformanceCheck => ({
      id: 'hosted-note',
      name: 'hosted-note',
      description: key,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: { key }
    });
    try {
      const run = a.getOrCreate(cold, () => 'http://x');
      run.touched = true;
      a.recordIdentity(run, { name: 'early', version: '1' });
      a.recordHostedCheck(run, 'n1', note('n1'));
      await a.persist(run);

      // Rebuilt without being seeded (a discover answered first), it records
      // something else: the earlier build's row is left as it was.
      await a.destroy(cellId(cold), false);
      const again = a.getOrCreate(cold, () => 'http://x');
      again.touched = true;
      expect(again.hostedWriter).not.toBe(run.hostedWriter);
      a.recordHostedCheck(again, 'n2', note('n2'));
      await a.persist(again);
      const rows = await store.loadChecks(cellId(cold));
      expect(rows.get(run.hostedWriter)).toHaveLength(2);

      const results = (await a.results(cellId(cold)))!;
      const hosted = results.checks.filter((c) => c.id.startsWith('hosted-'));
      expect(hosted.map((c) => c.description)).toEqual(
        expect.arrayContaining(['n1', 'n2', expect.stringContaining('early')])
      );
    } finally {
      await a.close();
    }
  });
});
