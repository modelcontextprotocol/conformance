/**
 * The MRTR scenario (sep-2322-client-request-state) driven the way Goose
 * drives it by hand: one chat per tool, each chat a new MCP session that
 * the host may hand to another process. Two apps over one store stand in
 * for two serverless isolates; the tools are reached through the run page's
 * 2026-07-28 composite, as Goose reached them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createHostedApp } from './server';
import { MemoryRunStore, type RunStore } from './store';
import { DEFAULT_COMPOSITES } from './composite';
import type { ConformanceCheck } from '../types';

const REV = '2026-07-28';
const MRTR = 'sep-2322-client-request-state';
const COMPOSITE = DEFAULT_COMPOSITES[REV].join('+');
const TOOLS = [
  'test_mrtr_echo_state',
  'test_mrtr_unrelated',
  'test_mrtr_no_state',
  'test_mrtr_no_result_type'
];

/** One process's handle on the shared store, which can be made to fail. */
class FlakyStore implements RunStore {
  /** How many of the next saveChecks calls carrying `failCheck` fail. */
  failSaves = 0;
  failCheck?: string;
  /** Every read fails while set. */
  failReads = false;
  constructor(private inner: RunStore) {}
  private read<T>(call: () => Promise<T>): Promise<T> {
    if (this.failReads) return Promise.reject(new Error('sqlite 503: down'));
    return call();
  }
  saveRun(id: string, scenarioName: string) {
    return this.inner.saveRun(id, scenarioName);
  }
  loadRun(id: string) {
    return this.read(() => this.inner.loadRun(id));
  }
  listRuns(prefix: string) {
    return this.read(() => this.inner.listRuns(prefix));
  }
  async saveChecks(id: string, writer: string, checks: ConformanceCheck[]) {
    if (this.failSaves > 0 && checks.some((c) => c.id === this.failCheck)) {
      this.failSaves--;
      throw new Error('sqlite 500: statement refused');
    }
    return this.inner.saveChecks(id, writer, checks);
  }
  loadChecks(id: string) {
    return this.read(() => this.inner.loadChecks(id));
  }
  deleteRun(id: string) {
    return this.inner.deleteRun(id);
  }
  saveSnapshot(runId: string, snapshotId: string, body: string) {
    return this.inner.saveSnapshot(runId, snapshotId, body);
  }
  loadSnapshot(runId: string, snapshotId: string) {
    return this.inner.loadSnapshot(runId, snapshotId);
  }
  listSnapshots(runId: string) {
    return this.inner.listSnapshots(runId);
  }
  deleteSnapshots(runId: string) {
    return this.inner.deleteSnapshots(runId);
  }
  saveChallenge(id: string, requester: string, at: number) {
    return this.inner.saveChallenge(id, requester, at);
  }
  listChallenges(since: number, requester: string) {
    return this.read(() => this.inner.listChallenges(since, requester));
  }
}

describe('MRTR across processes, one chat per tool', () => {
  const shared = new MemoryRunStore();
  const stores = [new FlakyStore(shared), new FlakyStore(shared)];
  const apps = stores.map((store) => createHostedApp({ store }));
  const servers: Server[] = [];
  const origins: string[] = [];

  beforeAll(async () => {
    for (const { app } of apps) {
      await new Promise<void>((resolve) => {
        const s = app.listen(0, () => {
          servers.push(s);
          origins.push(
            `http://localhost:${(s.address() as { port: number }).port}`
          );
          resolve();
        });
      });
    }
  });

  afterAll(async () => {
    for (const { sessions } of apps) await sessions.close();
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r())))
    );
  });

  let nextId = 1;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': REV,
    'io.modelcontextprotocol/clientInfo': { name: 'goose', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': { elicitation: {} }
  };

  /** One request, flushed as a serverless entry point flushes it. */
  async function rpc(
    p: number,
    path: string,
    method: string,
    params: Record<string, unknown> = {}
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': REV,
      'mcp-method': method
    };
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
    const res = await fetch(`${origins[p]}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: { ...params, _meta: meta }
      })
    });
    const text = await res.text();
    await apps[p].sessions.flush();
    return text;
  }

  /** A new chat on process `p`: discover, list, the tool and its retry. */
  async function chat(p: number, run: string, tool: string) {
    const mcp = `/s/${run}/${REV}/${COMPOSITE}/mcp`;
    await rpc(p, mcp, 'server/discover');
    await rpc(p, mcp, 'tools/list');
    const first = JSON.parse(
      await rpc(p, mcp, 'tools/call', { name: tool, arguments: {} })
    );
    if (first.result?.resultType !== 'input_required') return;
    await rpc(p, mcp, 'tools/call', {
      name: tool,
      arguments: {},
      inputResponses: {
        confirm: { action: 'accept', content: { confirmed: true } }
      },
      ...(first.result.requestState !== undefined && {
        requestState: first.result.requestState
      })
    });
  }

  async function passed(p: number, run: string): Promise<number> {
    const res = await fetch(`${origins[p]}/results/${run}/${REV}/${MRTR}`, {
      headers: { accept: 'application/json' }
    });
    expect(res.status).toBe(200);
    return (await res.json()).summary.passed;
  }

  /** Forget every cell of the run in process `p`, as its sweep would. */
  async function evict(p: number, run: string) {
    for (const r of apps[p].sessions.list())
      if (r.runId === run) await apps[p].sessions.destroy(r.id, false);
  }

  it('adds up every chat, on either process, evicted in between', async () => {
    const run = 'mrtrmp';
    let last = 0;
    for (const [i, tool] of TOOLS.entries()) {
      await chat(i % 2, run, tool);
      // Read on both processes between chats: a pass once seen stays.
      for (const p of [0, 1]) {
        const now = await passed(p, run);
        expect(now, `${tool}, read on ${p}`).toBeGreaterThanOrEqual(last);
        last = now;
      }
      await evict(i % 2, run);
    }
    expect(await passed(0, run)).toBe(5);
    expect(await passed(1, run)).toBe(5);
  });

  it('keeps a check whose first write the store refused', async () => {
    // The chat that records no-state-omitted lands on process 1, whose
    // write is refused once; process 1 then sees no more of the cell. On a
    // serverless host nothing would write that row again.
    const run = 'mrtrflaky';
    for (const [i, tool] of TOOLS.entries()) {
      const p = tool === 'test_mrtr_no_state' ? 1 : 0;
      if (p === 1) {
        stores[1].failCheck = 'sep-2322-client-no-state-omitted';
        stores[1].failSaves = 1;
      }
      await chat(p, run, tool);
      expect(stores[1].failSaves, `chat ${i}`).toBe(0);
    }
    expect(await passed(0, run)).toBe(5);
  });

  it('answers 503 while the store cannot be read, never an empty report', async () => {
    const run = 'mrtrdown';
    await chat(0, run, 'test_mrtr_unrelated');
    stores[1].failReads = true;
    try {
      for (const path of [
        `/results/${run}`,
        `/results/${run}?format=md`,
        `/results/${run}/${REV}/${MRTR}`
      ]) {
        const res = await fetch(`${origins[1]}${path}`, {
          headers: { accept: 'application/json' }
        });
        expect(res.status, path).toBe(503);
        expect((await res.json()).error).toMatch(/try again/);
      }
      const frozen = await fetch(`${origins[1]}/results/${run}/freeze`, {
        method: 'POST'
      });
      expect(frozen.status).toBe(503);
      await frozen.text();
    } finally {
      stores[1].failReads = false;
    }
    expect(await passed(1, run)).toBe(1);
  });
});
