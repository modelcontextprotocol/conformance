import { describe, it, expect } from 'vitest';
import { testScenarioContext } from '../../mock-server/testing';
import { InitializeScenario } from './initialize';

/**
 * The 2025-11-25 initialize mock answers the lifecycle it serves and turns
 * away methods it does not have: a dual-era client's 2026-07-28
 * `server/discover` probe must see an error, not an empty result it could
 * read as a discovery, so it falls back to `initialize`.
 */
describe('initialize scenario', () => {
  async function post(
    url: string,
    body: object,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  }

  it('rejects unknown request methods with -32601 and still serves its lifecycle', async () => {
    const scenario = new InitializeScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const probe = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': {
                name: 'dual',
                version: '0'
              },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        },
        { 'mcp-protocol-version': '2026-07-28' }
      );
      expect(probe.status).toBe(404);
      expect(await probe.json()).toMatchObject({
        id: 0,
        error: { code: -32601, message: 'Method not found: server/discover' }
      });

      const init = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'dual', version: '0' },
          capabilities: {}
        }
      });
      expect(init.status).toBe(200);
      expect((await init.json()).result.protocolVersion).toBe('2025-11-25');

      const initialized = await post(serverUrl, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });
      expect(initialized.status).toBe(202);

      // Notifications the mock does not know, and ping, behave as before.
      const unknownNotification = await post(serverUrl, {
        jsonrpc: '2.0',
        method: 'notifications/whatever'
      });
      expect(unknownNotification.status).toBe(200);
      const ping = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'ping'
      });
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });

      const list = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
      });
      expect(list.status).toBe(200);
      expect((await list.json()).result.tools).toEqual([]);

      const checks = scenario.getChecks();
      expect(checks.map((c) => c.status)).toEqual(['SUCCESS', 'INFO']);
    } finally {
      await scenario.stop();
    }
  });
});
