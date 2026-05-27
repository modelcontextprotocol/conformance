import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHostedApp } from './server';
import { SessionManager } from './session';
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

  it('lists scenarios', async () => {
    const res = await fetch(`${base}/scenarios`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((s: { name: string }) => s.name === 'initialize')).toBe(
      true
    );
    // auth scenarios excluded
    expect(list.some((s: { name: string }) => s.name.startsWith('auth/'))).toBe(
      false
    );
  });

  it('proxies to a scenario and records checks', async () => {
    const init = await fetch(`${base}/s/initialize`, {
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
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'vitest', version: '0' },
          capabilities: {}
        }
      })
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    expect(init.headers.get('link')).toContain(`/results/${sid}`);

    const body = await init.json();
    expect(body.result.serverInfo.name).toBe('test-server');

    const results = await fetch(`${base}/results/${sid}`);
    const data = await results.json();
    expect(data.summary.passed).toBeGreaterThanOrEqual(1);
    expect(
      data.checks.some(
        (c: { id: string }) => c.id === 'mcp-client-initialization'
      )
    ).toBe(true);
  });

  it('reuses a session across requests', async () => {
    const r1 = await fetch(`${base}/s/tools_call`, {
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
          protocolVersion: '2025-06-18',
          clientInfo: { name: 't', version: '0' },
          capabilities: {}
        }
      })
    });
    const sid = r1.headers.get('mcp-session-id')!;
    // SDK transport responds as SSE; just confirm the request was routed.
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await fetch(`${base}/s/tools_call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'add_numbers', arguments: { a: 2, b: 3 } }
      })
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const results = await fetch(`${base}/results/${sid}`).then((r) => r.json());
    expect(
      results.checks.some((c: { id: string }) => c.id === 'tool-add-numbers')
    ).toBe(true);
  });

  it('404s on unknown scenario', async () => {
    const res = await fetch(`${base}/s/does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(res.status).toBe(404);
  });

  it('exposes meta MCP tools', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })
    });
    const text = await res.text();
    expect(text).toContain('list_scenarios');
    expect(text).toContain('start_session');
    expect(text).toContain('get_results');
  });
});
