import { describe, it, expect } from 'vitest';
import handler from './valtown';

describe('val.town fetch bridge', () => {
  async function post(path: string, body: object) {
    return handler(
      new Request(`http://test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
      })
    );
  }

  it('serves a raw-http scenario and records checks', async () => {
    const r = await post('/s/ft1/2025-11-25/initialize', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'ft', version: '0' },
        capabilities: {}
      }
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('link')).toContain(
      '/results/ft1/2025-11-25/initialize>'
    );
    const checks = await handler(
      new Request('http://test/results/ft1/2025-11-25/initialize')
    ).then((r) => r.json());
    expect(checks.summary.passed).toBeGreaterThanOrEqual(1);
  });

  it('serves an SDK-transport scenario (tools_call) statelessly', async () => {
    await post('/s/ft2/2025-11-25/tools_call/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'ft', version: '0' },
        capabilities: {}
      }
    }).then((r) => r.text());
    const r = await post('/s/ft2/2025-11-25/tools_call/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 7, b: 4 } }
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('The sum of 7 and 4 is 11');
  });

  it('marks single-process scenarios as not startable on val.town', async () => {
    const r = await post('/s/x/2025-11-25/sse-retry', { jsonrpc: '2.0' });
    expect(r.status).toBe(501);
    expect((await r.json()).reason).toMatch(/single-process host/);
    const list = await handler(new Request('http://test/scenarios')).then((r) =>
      r.json()
    );
    const cell = list.find(
      (s: { name: string }) => s.name === 'sep-2322-client-request-state'
    ).cells[1];
    expect(cell).toMatchObject({
      revision: '2026-07-28',
      startable: false,
      startReason: expect.stringMatching(/single-process host/)
    });
  });
});
