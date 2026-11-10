import { describe, it, expect } from 'vitest';
import http from 'http';
import { createServer } from './createServer';
import { testScenarioContext } from '../../../../mock-server/testing';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck
} from '../../../../types';

describe('auth helper createServer — stateless /mcp', () => {
  it('records a FAILURE in the scenario log when the stateless wire rejects a request', async () => {
    const checks: ConformanceCheck[] = [];
    const app = createServer(
      testScenarioContext(DRAFT_PROTOCOL_VERSION),
      checks,
      () => 'http://rs.test',
      () => 'http://as.test',
      { authMiddleware: (_req, _res, next) => next() }
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      // A stateful initialize on the stateless wire: no header, no _meta.
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {} }
        })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(-32020);
      const rejected = checks.filter(
        (c) => c.id === 'stateless-request-rejected'
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: 'FAILURE',
        errorMessage: 'Missing MCP-Protocol-Version header',
        details: {
          status: 400,
          code: -32020,
          method: 'initialize',
          headerVersion: null
        }
      });

      // A well-formed stateless request records nothing of the kind.
      const ok = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': DRAFT_PROTOCOL_VERSION
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      });
      expect(ok.status).toBe(200);
      expect(
        checks.filter((c) => c.id === 'stateless-request-rejected')
      ).toHaveLength(1);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
