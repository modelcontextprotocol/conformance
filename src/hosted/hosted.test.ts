import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHostedApp } from './server';
import { SessionManager, listHostableScenarios } from './session';
import type { Server } from 'http';

describe('hosted server', () => {
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

  async function postMcp(
    path: string,
    body: object,
    headers: Record<string, string> = {}
  ) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers
      },
      body: JSON.stringify(body)
    });
  }

  it('lists only scenarios that implement handler()', async () => {
    const list = await fetch(`${base}/scenarios`).then((r) => r.json());
    const names = list.map((s: { name: string }) => s.name);
    expect(names).toContain('initialize');
    expect(names).toContain('http-standard-headers'); // draft, BaseHttpScenario
    expect(names).toContain('sep-2322-client-request-state'); // draft, express
    // auth scenarios have no handler() → excluded
    expect(names.some((n: string) => n.startsWith('auth/'))).toBe(false);
  });

  it('mounts a raw-http scenario at /s/<name>/<id> and records checks', async () => {
    const res = await postMcp('/s/initialize/t1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toContain('/results/t1');
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('test-server');

    const results = await fetch(`${base}/results/t1`).then((r) => r.json());
    expect(results.scenario).toBe('initialize');
    expect(
      results.checks.some(
        (c: { id: string }) => c.id === 'mcp-client-initialization'
      )
    ).toBe(true);
  });

  it('mounts an express scenario, accumulating checks across stateless requests', async () => {
    // tools_call uses StreamableHTTPServerTransport with sessionIdGenerator: undefined,
    // i.e. fully stateless. Correlation must come from the path-embedded id.
    const r1 = await postMcp('/s/tools_call/t2/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    });
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await postMcp('/s/tools_call/t2/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 2, b: 3 } }
    });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('The sum of 2 and 3 is 5');

    const results = await fetch(`${base}/results/t2`).then((r) => r.json());
    expect(
      results.checks.some((c: { id: string }) => c.id === 'tool-add-numbers')
    ).toBe(true);
  });

  it('mounts a draft scenario (request-metadata) directly', async () => {
    // request-metadata simulates a version rejection on the *first* request to
    // exercise client retry, then accepts. Send twice — both with no
    // mcp-session-id (stateless) — and confirm checks accumulate via path id.
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 'DRAFT-2026-v1',
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    };
    const headers = { 'mcp-protocol-version': 'DRAFT-2026-v1' };
    const r1 = await postMcp('/s/request-metadata/t3', init, headers);
    expect(r1.status).toBe(400);
    expect((await r1.json()).error.code).toBe(-32004);
    const r2 = await postMcp('/s/request-metadata/t3', init, headers);
    expect(r2.status).toBe(200);
    await r2.text();

    const results = await fetch(`${base}/results/t3`).then((r) => r.json());
    expect(results.scenario).toBe('request-metadata');
    expect(
      results.checks.some(
        (c: { id: string }) =>
          c.id === 'sep-2575-http-client-sends-version-header'
      )
    ).toBe(true);
  });

  it('json-schema-ref-deref embeds the public mounted URL in the canary $ref', async () => {
    const r1 = await postMcp('/s/json-schema-ref-no-deref/t4/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 'DRAFT-2026-v1',
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    });
    await r1.text();
    const r2 = await postMcp('/s/json-schema-ref-no-deref/t4/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    const text = await r2.text();
    // Canary URL should be the *mounted* base, not localhost:randomport
    expect(text).toContain(
      `${base}/s/json-schema-ref-no-deref/t4/canary/profile-schema.json`
    );
  });

  it('GET /s/<scenario> mints a run and returns mcpUrl', async () => {
    const res = await fetch(`${base}/s/tools_call`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.mcpUrl).toBe(`${base}/s/tools_call/${body.runId}/mcp`);
    expect(body.resultsUrl).toBe(`${base}/results/${body.runId}`);
  });

  it('isolates runs with the same scenario but different ids', async () => {
    await postMcp('/s/initialize/iso-a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'a', version: '0' },
        capabilities: {}
      }
    }).then((r) => r.text());
    await postMcp('/s/initialize/iso-b', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'b', version: '0' },
        capabilities: {}
      }
    }).then((r) => r.text());

    const a = await fetch(`${base}/results/iso-a`).then((r) => r.json());
    const b = await fetch(`${base}/results/iso-b`).then((r) => r.json());
    expect(a.checks[0].details.clientName).toBe('a');
    expect(b.checks[0].details.clientName).toBe('b');
  });

  it('rejects unknown scenarios and bad run-ids', async () => {
    expect(
      (await postMcp('/s/does-not-exist/x', { jsonrpc: '2.0' })).status
    ).toBe(404);
    expect(
      (await postMcp('/s/initialize/bad..id', { jsonrpc: '2.0' })).status
    ).toBe(400);
    // auth scenario exists but has no handler()
    expect(
      (await postMcp('/s/auth/basic-cimd/x', { jsonrpc: '2.0' })).status
    ).toBe(501);
  });

  it('exposes meta MCP tools', async () => {
    const res = await postMcp('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    });
    const text = await res.text();
    expect(text).toContain('list_scenarios');
    expect(text).toContain('start_run');
    expect(text).toContain('get_results');
  });

  it('every hostable scenario can be instantiated without binding a port', () => {
    // Guard against regressions where a handler() implementation reaches for
    // this._server / this.port etc.
    for (const name of listHostableScenarios()) {
      const run = sessions.getOrCreate(name, `probe-${name}`, () => 'http://x');
      expect(typeof run.listener).toBe('function');
    }
  });
});
