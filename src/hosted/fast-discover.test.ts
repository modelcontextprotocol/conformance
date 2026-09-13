/**
 * `server/discover` against a slow store. A client may give discover only a
 * second before it falls back to a legacy initialize (the Copilot runtime
 * does), so the answer must not wait on the store: not on seeding the cell
 * from it, and — on a long-lived process — not on writing the record back.
 * A fetch-style entry point that flushes before it answers (valtown.ts) waits
 * for one store round trip, not one per row.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { createHostedApp } from './server';
import { MemoryRunStore, type RunStore } from './store';
import { IDENTITY_CHECK_ID } from './identity';
import { MODERN_PROBE_CHECK_ID } from './wire';
import { toFetchHandler } from '../../examples/hosted/fetch-bridge';
import type { ConformanceCheck } from '../types';

const STATELESS = '2026-07-28';
const STATEFUL = '2025-11-25';
const DELAY_MS = 300;

/** A MemoryRunStore whose every call takes `delayMs`, counting calls. */
class SlowStore implements RunStore {
  readonly inner = new MemoryRunStore();
  calls: string[] = [];
  constructor(private readonly delayMs = DELAY_MS) {}
  private async slow<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    await new Promise((r) => setTimeout(r, this.delayMs));
    return fn();
  }
  saveRun(id: string, scenarioName: string) {
    return this.slow('saveRun', () => this.inner.saveRun(id, scenarioName));
  }
  loadRun(id: string) {
    return this.slow('loadRun', () => this.inner.loadRun(id));
  }
  listRuns(prefix: string) {
    return this.slow('listRuns', () => this.inner.listRuns(prefix));
  }
  saveChecks(id: string, writer: string, checks: ConformanceCheck[]) {
    return this.slow('saveChecks', () =>
      this.inner.saveChecks(id, writer, checks)
    );
  }
  loadChecks(id: string) {
    return this.slow('loadChecks', () => this.inner.loadChecks(id));
  }
  deleteRun(id: string) {
    return this.slow('deleteRun', () => this.inner.deleteRun(id));
  }
  saveSnapshot(runId: string, snapshotId: string, body: string) {
    return this.slow('saveSnapshot', () =>
      this.inner.saveSnapshot(runId, snapshotId, body)
    );
  }
  loadSnapshot(runId: string, snapshotId: string) {
    return this.slow('loadSnapshot', () =>
      this.inner.loadSnapshot(runId, snapshotId)
    );
  }
  listSnapshots(runId: string) {
    return this.slow('listSnapshots', () => this.inner.listSnapshots(runId));
  }
  deleteSnapshots(runId: string) {
    return this.slow('deleteSnapshots', () =>
      this.inner.deleteSnapshots(runId)
    );
  }
}

/** A 2026-07-28 request as a client sends it: version in header and _meta. */
function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  version = STATELESS
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': version
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientInfo': {
            name: 'fast-discover-test',
            version: '1.0.0'
          },
          'io.modelcontextprotocol/clientCapabilities': {
            sampling: {},
            elicitation: { form: {}, url: {} }
          }
        }
      }
    })
  });
}

/** Copilot's discover, but for the client name. */
const discoverRequest = (url: string) => rpc(url, 'server/discover');

const addNumbers = (url: string, a: number, b: number) =>
  rpc(url, 'tools/call', { name: 'add_numbers', arguments: { a, b } });

type Hosted = ReturnType<typeof createHostedApp>;
type Entry = (req: Request) => Promise<Response>;

const opened: Array<{ hosted: Hosted; server?: Server }> = [];

afterEach(async () => {
  for (const { hosted, server } of opened.splice(0)) {
    await hosted.sessions.flush();
    await hosted.sessions.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
});

function hostedOn(store: RunStore | undefined): Hosted {
  const hosted = createHostedApp({ store });
  opened.push({ hosted });
  return hosted;
}

/** A real HTTP listener, the way a long-lived Node process serves. */
async function listen(hosted: Hosted): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = hosted.app.listen(0, () => resolve(s));
  });
  opened.find((o) => o.hosted === hosted)!.server = server;
  return `http://localhost:${(server.address() as { port: number }).port}`;
}

/** What the client gets, and how long until it has all of it. */
async function timed(
  send: () => Promise<Response>
): Promise<{ ms: number; status: number; body: unknown; type: string }> {
  const t0 = performance.now();
  const res = await send();
  const text = await res.text();
  return {
    ms: performance.now() - t0,
    status: res.status,
    body: JSON.parse(text),
    type: res.headers.get('content-type') ?? ''
  };
}

/** The request through a fetch entry that flushes first (valtown.ts). */
function flushingEntry(hosted: Hosted): Entry {
  const bridge = toFetchHandler(hosted.app);
  return async (req) => {
    const res = await bridge(req);
    await hosted.sessions.flush();
    return res;
  };
}

/**
 * The same discover answered by a process with no store: the reference
 * answer, and the hosted checks it records per cell (identity, probe note).
 */
async function reference(path: string) {
  const hosted = hostedOn(undefined);
  const entry = flushingEntry(hosted);
  const answer = await timed(() =>
    entry(discoverRequest(`http://host${path}`))
  );
  const recorded = new Map(
    cellIdsOf(path).map((id) => [
      id,
      idsOf(hosted.sessions.get(id)?.hostedChecks ?? [])
    ])
  );
  return { ...answer, recorded };
}

const idsOf = (checks: ConformanceCheck[]) => checks.map((c) => c.id).sort();

/** The check ids of the hosted rows the store holds for a cell. */
async function hostedIn(store: SlowStore, id: string): Promise<string[]> {
  const rows = await store.inner.loadChecks(id);
  return idsOf(
    [...rows]
      .filter(([writer]) => writer.endsWith('/hosted'))
      .flatMap(([, checks]) => checks)
  );
}

/** A cold single cell, a composite, and a dated cell's uniform refusal. */
const CELLS = [
  `/s/run1/${STATELESS}/tools_call/mcp`,
  `/s/run1/${STATELESS}/tools_call+http-standard-headers+json-schema-ref-no-deref/mcp`,
  `/s/run1/${STATEFUL}/tools_call/mcp`
];

/** The cells a path names, as store ids. */
function cellIdsOf(path: string): string[] {
  const [, , runId, rev, ...rest] = path.split('/');
  const spec = rest.join('/').replace(/\/mcp$/, '');
  return spec.split('+').map((name) => `${runId}/${rev}/${name}`);
}

describe('server/discover with a slow store', () => {
  it.each(CELLS)(
    'answers %s from a long-lived process before any store call returns',
    async (path) => {
      const store = new SlowStore();
      const hosted = hostedOn(store);
      const base = await listen(hosted);
      const got = await timed(() => fetch(discoverRequest(`${base}${path}`)));
      expect(got.ms).toBeLessThan(DELAY_MS / 2);

      const want = await reference(path);
      expect(got.status).toBe(want.status);
      expect(got.type).toBe(want.type);
      expect(got.body).toEqual(want.body);

      // Recorded all the same, once the write lands.
      await hosted.sessions.flush();
      for (const [id, ids] of want.recorded) {
        expect(ids.length).toBeGreaterThan(0);
        expect(await store.inner.loadRun(id)).toBeDefined();
        expect(await hostedIn(store, id)).toEqual(ids);
      }
    }
  );

  it.each(CELLS)(
    'answers %s through a flushing entry in one store round trip',
    async (path) => {
      const store = new SlowStore();
      const entry = flushingEntry(hostedOn(store));
      const got = await timed(() =>
        entry(discoverRequest(`http://host${path}`))
      );
      // Before: seeding, then saveRun and two rows one after another — four
      // round trips for a cell, five for the composite (seeded child by
      // child).
      expect(got.ms).toBeLessThan(2 * DELAY_MS);
      expect(store.calls).not.toContain('loadChecks');

      const want = await reference(path);
      expect(got.status).toBe(want.status);
      expect(got.type).toBe(want.type);
      expect(got.body).toEqual(want.body);
      for (const [id, ids] of want.recorded) {
        expect(await store.inner.loadRun(id)).toBeDefined();
        expect(await hostedIn(store, id)).toEqual(ids);
      }
    }
  );

  it('sends no write for a discover that changed nothing', async () => {
    const store = new SlowStore();
    const entry = flushingEntry(hostedOn(store));
    const url = `http://host/s/again/${STATELESS}/tools_call/mcp`;
    await entry(discoverRequest(url));
    store.calls = [];
    const got = await timed(() => entry(discoverRequest(url)));
    expect(store.calls).toEqual([]);
    expect(got.ms).toBeLessThan(DELAY_MS / 2);
  });
});

describe('server/discover answered before seeding, across processes', () => {
  function twoProcesses() {
    const store = new SlowStore(20);
    const hosted = [hostedOn(store), hostedOn(store)];
    return { store, hosted, entries: hosted.map(flushingEntry) };
  }

  interface Judged {
    verdict: string;
    checks: string[];
  }

  async function judged(entry: Entry, id: string): Promise<Judged> {
    const res = await entry(new Request(`http://host/results/${id}`));
    const body = (await res.json()) as {
      verdict: string;
      checks: Array<{ id: string; status: string }>;
    };
    return {
      verdict: body.verdict,
      checks: body.checks.map((c) => `${c.id}:${c.status}`).sort()
    };
  }

  it('judges a cell the same from either process', async () => {
    const { entries } = twoProcesses();
    const [a, b] = entries;
    const id = `mp1/${STATELESS}/tools_call`;
    const url = `http://host/s/${id}/mcp`;
    expect((await a(discoverRequest(url))).status).toBe(200);
    expect((await b(rpc(url, 'tools/list'))).status).toBe(200);
    // A's cell was built for the discover without seeding; this request
    // seeds it with what B recorded.
    const called = await a(addNumbers(url, 5, 3));
    expect(await called.text()).toContain('The sum of 5 and 3 is 8');

    const onA = await judged(a, id);
    expect(await judged(b, id)).toEqual(onA);
    expect(onA.verdict).toBe('pass');
    expect(onA.checks).toContain(`${IDENTITY_CHECK_ID}:INFO`);

    // The same traffic to one process with no store is judged alike.
    const solo = flushingEntry(hostedOn(undefined));
    await solo(discoverRequest(url));
    await solo(rpc(url, 'tools/list'));
    await solo(addNumbers(url, 5, 3));
    expect(await judged(solo, id)).toEqual(onA);
  });

  it('seeds a scenario whose discover answer reads its log first', async () => {
    // request-metadata turns away the run's first request once. Process B
    // drew that rejection; a discover on A must not draw a second one.
    const { entries } = twoProcesses();
    const [a, b] = entries;
    const url = `http://host/s/mp2/${STATELESS}/request-metadata/mcp`;
    const first = await b(rpc(url, 'tools/list'));
    expect(first.status).toBe(400);
    expect((await first.json()).error.code).toBe(-32022);
    const discover = await a(discoverRequest(url));
    expect(discover.status).toBe(200);
  });

  it("keeps a process's own row when a discover rebuilds an evicted cell", async () => {
    const { store, hosted, entries } = twoProcesses();
    const [a, b] = entries;
    const id = `mp3/${STATELESS}/tools_call`;
    const url = `http://host/s/${id}/mcp`;
    await a(addNumbers(url, 1, 2));
    const writer = hosted[0].sessions.writerId;
    const rows = await store.inner.loadChecks(id);
    const before = rows.get(writer);
    expect(before?.length).toBeGreaterThan(0);
    const hostedBefore = [...rows].filter(([w]) => w.endsWith('/hosted'));
    expect(hostedBefore).toHaveLength(1);

    // Evicted from A's memory only; the discover rebuilds it from its id.
    await hosted[0].sessions.destroy(id, false);
    expect((await a(discoverRequest(url))).status).toBe(200);
    const after = await store.inner.loadChecks(id);
    expect(after.get(writer)).toEqual(before);
    // The rebuilt cell's hosted checks go to a row of their own.
    for (const [w, checks] of hostedBefore)
      expect(after.get(w)).toEqual(checks);
    for (const entry of [a, b])
      expect((await judged(entry, id)).checks).toContain(
        'tool-add-numbers:SUCCESS'
      );
  });
});

describe("an evicted cell's hosted checks", () => {
  /** A legacy handshake from `name`, as a 2025-11-25 client sends it. */
  const initialize = (url: string, name: string) =>
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: STATEFUL,
          clientInfo: { name, version: '1.0.0' },
          capabilities: {}
        }
      })
    });

  /** The clients and probe notes a cell's results show. */
  async function shown(entry: Entry, id: string) {
    const res = await entry(new Request(`http://host/results/${id}`));
    const { checks } = (await res.json()) as { checks: ConformanceCheck[] };
    return {
      clients: checks
        .filter((c) => c.id === IDENTITY_CHECK_ID)
        .map((c) => (c.details as { name: string }).name)
        .sort(),
      probes: checks.filter((c) => c.id === MODERN_PROBE_CHECK_ID).length
    };
  }

  /**
   * On a dated cell, a 2026-07-28 client's discover (a probe note) and its
   * fallback handshake (its identity), then the cell evicted from the
   * process's memory.
   */
  async function recordThenEvict(hosted: Hosted, id: string) {
    const entry = flushingEntry(hosted);
    const url = `http://host/s/${id}/mcp`;
    await (await entry(discoverRequest(url))).text();
    await (await entry(initialize(url, 'first-client'))).text();
    expect(await shown(entry, id)).toEqual({
      clients: ['first-client'],
      probes: 1
    });
    await hosted.sessions.destroy(id, false);
  }

  it('keeps what the process recorded before the cell was evicted', async () => {
    const hosted = hostedOn(new MemoryRunStore());
    const a = flushingEntry(hosted);
    const id = `ev1/${STATEFUL}/tools_call`;
    await recordThenEvict(hosted, id);

    // Rebuilt from its id; the next write must not drop the earlier ones.
    await (await a(initialize(`http://host/s/${id}/mcp`, 'second'))).text();
    expect(await shown(a, id)).toEqual({
      clients: ['first-client', 'second'],
      probes: 1
    });
  });

  it('shows the same from another process', async () => {
    const store = new MemoryRunStore();
    const hosted = [hostedOn(store), hostedOn(store)];
    const [a, b] = hosted.map(flushingEntry);
    const id = `ev2/${STATEFUL}/tools_call`;
    const url = `http://host/s/${id}/mcp`;
    await recordThenEvict(hosted[0], id);

    await (await a(discoverRequest(url))).text();
    await (await b(initialize(url, 'on-b'))).text();
    const want = { clients: ['first-client', 'on-b'], probes: 1 };
    expect(await shown(a, id)).toEqual(want);
    expect(await shown(b, id)).toEqual(want);
  });
});
