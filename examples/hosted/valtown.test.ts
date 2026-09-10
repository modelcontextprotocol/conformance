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
    const r = await post('/s/initialize/ft1', {
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
    expect(r.headers.get('link')).toContain('/results/ft1');
    const checks = await handler(new Request('http://test/results/ft1')).then(
      (r) => r.json()
    );
    expect(checks.summary.passed).toBeGreaterThanOrEqual(1);
  });

  it('serves an SDK-transport scenario (tools_call) statelessly', async () => {
    await post('/s/tools_call/ft2/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'ft', version: '0' },
        capabilities: {}
      }
    }).then((r) => r.text());
    const r = await post('/s/tools_call/ft2/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 7, b: 4 } }
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('The sum of 7 and 4 is 11');
  });

  it('blocks sse-retry through the bridge', async () => {
    const r = await handler(new Request('http://test/s/sse-retry/x'));
    expect(r.status).toBe(501);
  });
});
