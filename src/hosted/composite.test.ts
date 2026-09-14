import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createHostedApp } from './server';
import type { SessionManager } from './session';
import {
  DEFAULT_COMPOSITES,
  mergeLifecycle,
  mergeList,
  notComposableReason,
  parseComposite,
  routeFor
} from './composite';

const STATEFUL = '2025-11-25';
const STATELESS = '2026-07-28';

describe('composite routing rules', () => {
  it('reads a composite segment and refuses children that cannot share a URL', () => {
    expect(parseComposite('tools_call')).toBeUndefined();
    expect(parseComposite('tools_call+initialize+tools_call')).toEqual([
      'tools_call',
      'initialize'
    ]);
    expect(notComposableReason('tools_call')).toBeUndefined();
    expect(notComposableReason('auth/basic-cimd')).toMatch(/401/);
    expect(notComposableReason('request-metadata')).toMatch(/first request/);
  });

  it('routes each JSON-RPC message by what it is', () => {
    expect(routeFor({ id: 1, method: 'initialize' })).toEqual({
      kind: 'lifecycle'
    });
    expect(routeFor({ id: 1, method: 'tools/list' })).toEqual({
      kind: 'list',
      method: 'tools/list'
    });
    expect(
      routeFor({ id: 1, method: 'tools/call', params: { name: 'x' } })
    ).toEqual({ kind: 'addressed', list: 'tools/list', item: 'x' });
    expect(routeFor({ method: 'notifications/initialized' })).toEqual({
      kind: 'notification'
    });
    expect(routeFor({ id: 1, method: 'ping' })).toEqual({ kind: 'first' });
  });

  it('merges capabilities and lists, keeping the first owner of a name', () => {
    expect(
      mergeLifecycle([
        {
          child: 'a',
          result: { serverInfo: { name: 'a' }, capabilities: { tools: {} } }
        },
        { child: 'b' },
        {
          child: 'c',
          result: {
            capabilities: { tools: { listChanged: true }, prompts: {} }
          }
        }
      ])
    ).toEqual({
      serverInfo: { name: 'a' },
      capabilities: { tools: { listChanged: true }, prompts: {} }
    });
    const merged = mergeList('tools/list', [
      { child: 'a', result: { tools: [{ name: 'x' }, { name: 'y' }] } },
      { child: 'b', result: { tools: [{ name: 'y' }, { name: 'z' }] } }
    ]);
    expect(merged?.result).toEqual({
      tools: [{ name: 'x' }, { name: 'y' }, { name: 'z' }]
    });
    expect([...merged!.owners]).toEqual([
      ['x', 'a'],
      ['y', 'a'],
      ['z', 'b']
    ]);
  });
});

describe('composite cells on the hosted server', () => {
  let server: Server;
  let sessions: SessionManager;
  let base: string;

  beforeAll(async () => {
    const hosted = createHostedApp();
    sessions = hosted.sessions;
    await new Promise<void>((resolve) => {
      server = hosted.app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object')
          base = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await sessions.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The JSON-RPC message in a JSON or SSE response body. */
  async function answer(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('event-stream')) {
      const data = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      return JSON.parse(data);
    }
    return JSON.parse(text);
  }

  function statelessPost(
    url: string,
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    name?: string
  ) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': STATELESS,
        'mcp-method': method,
        ...(name && { 'mcp-name': name })
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': STATELESS,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': {
              name: 'composite-test',
              version: '0.0.0'
            }
          }
        }
      })
    });
  }

  async function verdict(runId: string, rev: string, scenario: string) {
    const report = (await (
      await fetch(`${base}/results/${runId}/${rev}`)
    ).json()) as {
      columns: { cells: { scenario: string; verdict: string }[] }[];
    };
    return report.columns[0].cells.find((c) => c.scenario === scenario)
      ?.verdict;
  }

  it('serves several stateless scenarios at one URL and scores each on its own', async () => {
    const url = `${base}/s/comp1/${STATELESS}/tools_call+http-standard-headers+json-schema-ref-no-deref/mcp`;

    const discover = await answer(
      await statelessPost(url, 1, 'server/discover')
    );
    const caps = (discover.result as { capabilities: Record<string, unknown> })
      .capabilities;
    expect(Object.keys(caps)).toEqual(
      expect.arrayContaining(['tools', 'resources', 'prompts'])
    );

    const listed = await answer(await statelessPost(url, 2, 'tools/list'));
    const names = (listed.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name
    );
    expect(names).toEqual(
      expect.arrayContaining(['add_numbers', 'test_headers', 'lookup_user'])
    );

    const called = await answer(
      await statelessPost(
        url,
        3,
        'tools/call',
        { name: 'add_numbers', arguments: { a: 5, b: 3 } },
        'add_numbers'
      )
    );
    expect(JSON.stringify(called.result)).toContain('8');

    // The ref-deref child answers its tool too, rather than -32601.
    const looked = await answer(
      await statelessPost(
        url,
        4,
        'tools/call',
        { name: 'lookup_user', arguments: { id: 'alice' } },
        'lookup_user'
      )
    );
    expect(looked.result).toMatchObject({
      content: [{ type: 'text', text: 'No profile on file for user alice.' }]
    });

    // Each child scored in its own cell, as if the client had used its URL.
    expect(await verdict('comp1', STATELESS, 'tools_call')).toBe('pass');
    expect(await verdict('comp1', STATELESS, 'json-schema-ref-no-deref')).toBe(
      'pass'
    );
    expect(await verdict('comp1', STATELESS, 'http-standard-headers')).not.toBe(
      'incomplete'
    );
  });

  it('answers initialize on the stateful wire from every child', async () => {
    const url = `${base}/s/comp2/${STATEFUL}/initialize+tools_call/mcp`;
    const post = (id: number | undefined, method: string, params = {}) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(method !== 'initialize' && { 'mcp-protocol-version': STATEFUL })
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(id !== undefined && { id }),
          method,
          params
        })
      });

    const init = await answer(
      await post(1, 'initialize', {
        protocolVersion: STATEFUL,
        capabilities: {},
        clientInfo: { name: 'composite-test', version: '0.0.0' }
      })
    );
    expect(init.result).toMatchObject({
      protocolVersion: STATEFUL,
      capabilities: { tools: {} }
    });
    expect((await post(undefined, 'notifications/initialized')).status).toBe(
      202
    );
    const called = await answer(
      await post(2, 'tools/call', {
        name: 'add_numbers',
        arguments: { a: 5, b: 3 }
      })
    );
    expect(JSON.stringify(called.result)).toContain('8');

    expect(await verdict('comp2', STATEFUL, 'initialize')).toBe('pass');
    expect(await verdict('comp2', STATEFUL, 'tools_call')).toBe('pass');
  });

  it('answers a legacy initialize on the stateless wire like a single cell', async () => {
    // One child (json-schema-ref-no-deref) would complete the handshake on
    // its own, and the merged answer used to accept it; then every child
    // failed the client for the 2025-11-25 requests that followed.
    const names = DEFAULT_COMPOSITES[STATELESS];
    expect(names).toContain('json-schema-ref-no-deref');
    const url = `${base}/s/comp6/${STATELESS}/${names.join('+')}/mcp`;
    const legacy = (id: number | undefined, method: string, params = {}) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': STATEFUL
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(id !== undefined && { id }),
          method,
          params
        })
      });
    const init = await legacy(7, 'initialize', {
      protocolVersion: STATEFUL,
      capabilities: {},
      clientInfo: { name: 'legacy-client', version: '1.0.0' }
    });
    expect(init.status).toBe(400);
    expect(await init.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: [STATELESS], requested: STATEFUL }
      }
    });
    for (const name of names) {
      const results = (await (
        await fetch(`${base}/results/comp6/${STATELESS}/${name}`)
      ).json()) as { checks: { id: string; status: string }[] };
      const ids = results.checks.map((c) => c.id);
      expect(ids, name).toContain('hosted-legacy-probe');
      expect(ids, name).not.toContain('hosted-wrong-revision');
    }
  });

  it('answers a GET on its MCP path with 405, and sends a browser to its page', async () => {
    const names = DEFAULT_COMPOSITES[STATELESS];
    const cell = `${base}/s/comp7/${STATELESS}/${names.join('+')}`;
    // VS Code's old HTTP+SSE fallback after a 400: not Express's HTML 404.
    const get = await fetch(`${cell}/mcp`, {
      headers: { accept: 'text/event-stream' }
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(await get.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
    const results = (await (
      await fetch(`${base}/results/comp7/${STATELESS}/${names[0]}`)
    ).json()) as { checks: { id: string; status: string }[] };
    expect(
      results.checks
        .filter((c) => c.id === 'hosted-get-on-mcp-path')
        .map((c) => c.status)
    ).toEqual(['INFO']);

    const browser = await fetch(`${cell}/mcp`, {
      headers: { accept: 'text/html' },
      redirect: 'manual'
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.get('location')).toBe(cell);
  });

  it('refuses composites it cannot serve, saying why', async () => {
    const post = (path: string) =>
      statelessPost(
        `${base}/s/comp3/${STATELESS}/${path}/mcp`,
        1,
        'tools/list'
      );
    const shared = await post('tools_call+request-metadata');
    expect(shared.status).toBe(400);
    expect((await shared.json()).error).toMatch(
      /'request-metadata' cannot share a URL/
    );
    expect((await post('tools_call+no-such-scenario')).status).toBe(404);
    const single = await post('tools_call+');
    expect(single.status).toBe(404);
    expect((await single.json()).error).toMatch(/two or more/);
  });

  it('shows the one URL and each scenario behind it', async () => {
    const view = (await (
      await fetch(
        `${base}/s/comp4/${STATELESS}/tools_call+http-standard-headers?format=json`
      )
    ).json()) as { url: string; children: { scenario: string }[] };
    expect(view.url).toBe(
      `${base}/s/comp4/${STATELESS}/tools_call+http-standard-headers/mcp`
    );
    expect(view.children.map((c) => c.scenario)).toEqual([
      'tools_call',
      'http-standard-headers'
    ]);
    const html = await (
      await fetch(
        `${base}/s/comp4/${STATELESS}/tools_call+http-standard-headers`,
        { headers: { accept: 'text/html' } }
      )
    ).text();
    expect(html).toContain('2 scenarios, one URL');
  });

  it('offers a ready-made composite per revision on the run page', async () => {
    const html = await (
      await fetch(`${base}/s/comp5`, { headers: { accept: 'text/html' } })
    ).text();
    expect(html).toContain(
      'Add one URL per revision for the scenarios that need no sign-in'
    );
    expect(html).toContain(
      `${base}/s/comp5/${STATELESS}/tools_call+http-standard-headers+http-custom-headers+json-schema-ref-no-deref+sep-2322-client-request-state/mcp`
    );
    expect(html).toContain(
      `${base}/s/comp5/${STATEFUL}/initialize+tools_call/mcp`
    );
  });
});
