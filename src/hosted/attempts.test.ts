/**
 * Resetting a cell, and the traffic every cell records: across two
 * processes that share a store (with and without eviction between
 * requests, as val.town isolates behave), and in one process without a
 * store.
 */

import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { Server } from 'http';
import { createHostedApp } from './server';
import { MemoryRunStore } from './store';
import { toFetchHandler } from '../../examples/hosted/fetch-bridge';
import {
  TRAFFIC_BODY_CAP,
  TRAFFIC_CELL_BYTES,
  TRAFFIC_ROW_EXCHANGES,
  addExchange,
  capped,
  emptyRow,
  exchangeFor,
  redacted,
  refusedCredential,
  credentialHash,
  issuedBy,
  type Exchange
} from './traffic';

const REV = '2026-07-28';
const CELL = 'http-standard-headers';

const META = {
  'io.modelcontextprotocol/protocolVersion': REV,
  'io.modelcontextprotocol/clientInfo': { name: 'attempts-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

/** tools/list as a 2026-07-28 client sends it, Mcp-Method set to `said`. */
function toolsList(url: string, said = 'tools/list'): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': REV,
      'mcp-method': said
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: META }
    })
  });
}

type Hosted = ReturnType<typeof createHostedApp>;
const opened: Hosted[] = [];
afterAll(async () => {
  for (const h of opened) await h.sessions.close();
});

/** A process behind the fetch bridge that flushes, and may forget its cells. */
function processOn(store: MemoryRunStore | undefined, evict: boolean) {
  const hosted = createHostedApp({ store });
  opened.push(hosted);
  const bridge = toFetchHandler(hosted.app);
  return async (req: Request) => {
    const res = await bridge(req);
    const body = await res.text();
    await hosted.sessions.flush();
    if (evict) {
      for (const run of hosted.sessions.list())
        await hosted.sessions.destroy(run.id, false);
    }
    return { status: res.status, body, headers: res.headers };
  };
}

describe.each([
  { label: 'two processes sharing a store', evict: false },
  {
    label: 'two processes that forget every cell after each request',
    evict: true
  }
])('reset, $label', ({ evict }) => {
  const store = new MemoryRunStore();
  const [a, b] = [processOn(store, evict), processOn(store, evict)];
  const run = evict ? 'rstev' : 'rst';
  const cell = `${run}/${REV}/${CELL}`;
  const mcp = `http://host/s/${cell}/mcp`;
  const results = `http://host/results/${cell}`;
  const json = async (p: typeof a, url: string) =>
    JSON.parse((await p(new Request(url))).body);

  it('a failing attempt, a reset, then a passing one: the cell passes, the failure listed under it', async () => {
    // Attempt 1 fails: the header names another method than the body.
    await a(toolsList(mcp, 'tools/call'));
    const first = await json(b, results);
    expect(first).toMatchObject({ verdict: 'fail', attempt: 1 });

    // Reset in the other process: attempt 2 waits for the next request.
    const reset = await b(new Request(`${results}/reset`, { method: 'POST' }));
    expect(reset.status).toBe(200);
    expect(JSON.parse(reset.body)).toMatchObject({ attempt: 2 });
    const waiting = await json(a, results);
    expect(waiting).toMatchObject({
      verdict: 'incomplete',
      state: 'not-tried',
      attempt: 2,
      earlier: [{ attempt: 1, verdict: 'fail', state: 'fail' }]
    });
    expect(waiting.note).toMatch(
      /^reset at \d\d:\d\d:\d\d UTC: attempt 2 starts with your client’s next request$/
    );
    expect(waiting.earlier[0].cause).toMatch(/^sep-2243-/);
    // The run report reads the latest attempt: not tried, not failed.
    const reportBefore = await json(a, `http://host/results/${run}`);
    const before = reportBefore.columns
      .find((c: { revision: string }) => c.revision === REV)
      .cells.find((c: { scenario: string }) => c.scenario === CELL);
    expect(before).toMatchObject({ state: 'not-tried', attempt: 2 });

    // Attempt 2, fixed, lands on the process that served attempt 1.
    await a(toolsList(mcp));
    const second = await json(b, results);
    expect(second).toMatchObject({ verdict: 'pass', attempt: 2 });
    expect(second.earlier).toEqual([
      expect.objectContaining({ attempt: 1, verdict: 'fail' })
    ]);
    const report = await json(b, `http://host/results/${run}`);
    const col = report.columns.find(
      (c: { revision: string }) => c.revision === REV
    );
    expect(
      col.cells.find((c: { scenario: string }) => c.scenario === CELL)
    ).toMatchObject({ verdict: 'pass', state: 'pass', attempt: 2 });

    // The page: the latest attempt, the earlier one folded under it.
    const page = (
      await a(new Request(results, { headers: { accept: 'text/html' } }))
    ).body;
    expect(page).toContain('<b>Attempt 2</b>');
    expect(page).toContain('1 earlier attempt');
    expect(page).toMatch(
      /Attempt 1 · [\d:.]+ UTC · <span class=glyph aria-hidden=true>✗<\/span> fail — sep-2243-/
    );
    expect(page).toContain('Reset this cell');
    // Each attempt's traffic is its own.
    const lines = (await b(new Request(`${results}/traffic.jsonl`))).body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.attempt, l.headers['mcp-method']])).toEqual([
      [1, 'tools/call'],
      [2, 'tools/list']
    ]);
  });
});

describe('reset in one process without a store', () => {
  const p = processOn(undefined, false);
  const cell = `solo/${REV}/${CELL}`;
  const results = `http://host/results/${cell}`;

  it('keeps the earlier attempt and judges the latest', async () => {
    await p(toolsList(`http://host/s/${cell}/mcp`, 'tools/call'));
    await p(new Request(`${results}/reset`, { method: 'POST' }));
    await p(toolsList(`http://host/s/${cell}/mcp`));
    const got = JSON.parse((await p(new Request(results))).body);
    expect(got).toMatchObject({
      verdict: 'pass',
      attempt: 2,
      earlier: [{ attempt: 1, verdict: 'fail' }]
    });
    // A browser's form lands back on the cell's page.
    const form = await p(
      new Request(`${results}/reset`, {
        method: 'POST',
        headers: { accept: 'text/html' }
      })
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(`/results/${cell}`);
  });

  it('refuses to reset a cell that does not apply to the revision', async () => {
    const res = await p(
      new Request(`http://host/results/solo/${REV}/initialize/reset`, {
        method: 'POST'
      })
    );
    expect(res.status).toBe(404);
  });
});

describe('traffic on a header cell, over two connections', () => {
  let server: Server;
  let origin: string;
  const hosted = createHostedApp();
  opened.push(hosted);

  /** One request on its own connection (a fresh agent each time). */
  function post(path: string, headers: Record<string, string>, body: object) {
    const agent = new http.Agent({ keepAlive: false });
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        `${origin}${path}`,
        { method: 'POST', agent, headers },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  it('records each request’s headers and connection, and ties the failure to its exchange', async () => {
    await new Promise<void>((resolve) => {
      server = hosted.app.listen(0, () => resolve());
    });
    origin = `http://localhost:${(server.address() as { port: number }).port}`;
    try {
      const path = `/s/conn/${REV}/${CELL}/mcp`;
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': REV,
        'user-agent': 'attempts-test/1',
        authorization: 'Bearer a-secret-never-kept'
      };
      const list = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: META }
      };
      await post(path, { ...headers, 'mcp-method': 'tools/list' }, list);
      await post(
        path,
        { ...headers, 'mcp-method': 'prompts/list' },
        { ...list, id: 2 }
      );
      const cell = `${origin}/results/conn/${REV}/${CELL}`;
      const lines = (await fetch(`${cell}/traffic.jsonl`).then((r) => r.text()))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Exchange & { connection: number });
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.connection)).toEqual([1, 2]);
      expect(lines[1]).toMatchObject({
        lane: 'mcp',
        method: 'POST',
        path: '/mcp',
        rpc: [{ method: 'tools/list', id: 2 }],
        authorization: 'present',
        headers: {
          'mcp-method': 'prompts/list',
          'mcp-protocol-version': REV,
          'user-agent': 'attempts-test/1',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        status: 200
      });
      // Authorization is kept as present, never its value.
      const all = JSON.stringify(lines);
      expect(all).not.toContain('a-secret-never-kept');
      expect(lines[1].headers).not.toHaveProperty('authorization');

      const json = await fetch(cell).then((r) => r.json());
      expect(json.verdict).toBe('fail');
      const page = await fetch(cell, {
        headers: { accept: 'text/html' }
      }).then((r) => r.text());
      // What to fix leads, tied to exchange 2 with its header marked.
      const fix = page.slice(page.indexOf('What to fix'));
      expect(fix).toContain('It was decided by exchange <a href="#x2">2</a>');
      expect(fix).toContain('<mark>mcp-method: prompts/list</mark>');
      // Expected against what the client sent, from the check's details.
      expect(fix).toContain(
        '<th>method</th><td><code>&quot;tools/list&quot;</code></td><td><code>&quot;prompts/list&quot;</code></td>'
      );
      expect(page.indexOf('What to fix')).toBeLessThan(
        page.indexOf('id=traffic')
      );
      expect(page).toContain('Traffic: 2 exchanges on 2 connections');
      expect(page).toContain('Connection 2 opens');
      expect(page).toContain('<tr id=x2 class=bad>');
      // The log rows the traffic replaces are not listed as checks.
      expect(page).not.toContain('<code>incoming-request</code>');
      expect(page).not.toContain('a-secret-never-kept');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('traffic rows', () => {
  const exchange = (i: number, extra: Partial<Exchange> = {}): Exchange => ({
    at: new Date(Date.UTC(2026, 8, 14, 9, 0, 0, i)).toISOString(),
    ms: 1,
    lane: 'mcp',
    method: 'POST',
    path: '/mcp',
    headers: {},
    authorization: 'absent',
    body: `{"jsonrpc":"2.0","id":${i},"method":"m${i}"}`,
    status: 200,
    ...extra
  });

  it('keeps at most TRAFFIC_ROW_EXCHANGES a row and counts the rest', () => {
    const row = emptyRow();
    const size = { bytes: 0 };
    for (let i = 0; i < TRAFFIC_ROW_EXCHANGES + 7; i++)
      addExchange(row, exchange(i), size);
    expect(row.exchanges).toHaveLength(TRAFFIC_ROW_EXCHANGES);
    expect(row.omitted).toBe(7);
  });

  it('keeps at most TRAFFIC_ROW_BYTES a row', () => {
    const row = emptyRow();
    const size = { bytes: 0 };
    const big = 'x'.repeat(TRAFFIC_BODY_CAP);
    for (let i = 0; i < 40; i++)
      addExchange(row, exchange(i, { responseBody: big + i }), size);
    expect(row.exchanges.length).toBeLessThan(40);
    expect(row.omitted).toBe(40 - row.exchanges.length);
    expect(JSON.stringify(row).length).toBeLessThan(200 * 1024);
  });

  it('folds the same exchange asked again into a repeat', () => {
    const row = emptyRow();
    const size = { bytes: 0 };
    addExchange(row, exchange(1, { body: '{"id":1,"method":"x"}' }), size);
    addExchange(row, exchange(2, { body: '{"id":2,"method":"x"}' }), size);
    expect(row.exchanges).toHaveLength(1);
    expect(row.exchanges[0].repeats).toBe(1);
  });

  it('cuts a body at TRAFFIC_BODY_CAP and says how big it was', () => {
    const text = 'y'.repeat(TRAFFIC_BODY_CAP + 100);
    expect(capped(text)).toEqual({
      text: 'y'.repeat(TRAFFIC_BODY_CAP),
      bytes: TRAFFIC_BODY_CAP + 100
    });
    expect(capped('small')).toEqual({ text: 'small' });
  });

  it('a store keeps a cell’s traffic under TRAFFIC_CELL_BYTES', async () => {
    const store = new MemoryRunStore();
    const bulky = (n: number) => ({
      exchanges: [exchange(n, { responseBody: 'z'.repeat(400 * 1024) })],
      omitted: 0,
      issued: []
    });
    await store.saveTraffic('c', 'w1', bulky(1));
    await store.saveTraffic('c', 'w2', bulky(2));
    await store.saveTraffic('c', 'w3', bulky(3));
    const rows = await store.loadTraffic('c');
    expect(rows.size).toBe(2);
    const total = Array.from(rows.values()).reduce(
      (n, r) => n + JSON.stringify(r).length,
      0
    );
    expect(total).toBeLessThanOrEqual(TRAFFIC_CELL_BYTES);
  });

  it('ties a check to the exchange under way when it was stamped', () => {
    const list = [exchange(0, { ms: 5 }), exchange(100, { ms: 5 })];
    const at = (ms: number) =>
      new Date(Date.UTC(2026, 8, 14, 9, 0, 0, ms)).toISOString();
    expect(exchangeFor(at(3), list)).toBe(0);
    expect(exchangeFor(at(104), list)).toBe(1);
    expect(exchangeFor(at(50), list)).toBe(0);
    expect(exchangeFor(undefined, list)).toBeUndefined();
  });

  it('keeps no token values in bodies, and knows an issued credential again', () => {
    const response = JSON.stringify({
      access_token: 'tok-1',
      refresh_token: 'ref-1',
      token_type: 'Bearer'
    });
    expect(redacted(response)).toBe(
      '{"access_token":"(not kept)","refresh_token":"(not kept)","token_type":"Bearer"}'
    );
    expect(
      redacted('grant_type=refresh_token&refresh_token=ref-1&client_id=c')
    ).toBe('grant_type=refresh_token&refresh_token=%28not+kept%29&client_id=c');
    expect(redacted('{"access_token":"cut sh')).toBe('{"access_token":"cut sh');
    expect(redacted('{"access_token":"a", "x": "cut')).toBe(
      '{"access_token":"(not kept)", "x": "cut'
    );

    const issued = new Set([
      ...issuedBy('/token', 200, undefined, response),
      ...issuedBy('/register', 201, undefined, '{"client_id":"c-1"}'),
      ...issuedBy('/authorize', 302, 'http://cb/?code=code-1&state=s', '')
    ]);
    expect(issued).toEqual(
      new Set(['tok-1', 'ref-1', 'c-1', 'code-1'].map(credentialHash))
    );
    expect(refusedCredential(issued, 'Bearer tok-1', '/mcp', '', '')).toBe(
      'token'
    );
    expect(
      refusedCredential(
        issued,
        undefined,
        '/token',
        'grant_type=authorization_code&code=code-1',
        'application/x-www-form-urlencoded'
      )
    ).toBe('code');
    expect(
      refusedCredential(issued, undefined, '/authorize?client_id=c-1', '', '')
    ).toBe('client_id');
    // A new registration may name anything; fresh credentials pass.
    expect(
      refusedCredential(
        issued,
        'Bearer tok-2',
        '/register',
        '{"client_id":"c-1"}',
        'application/json'
      )
    ).toBeUndefined();
  });
});
