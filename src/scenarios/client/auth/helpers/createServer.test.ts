import { describe, it, expect } from 'vitest';
import http from 'http';
import { createServer } from './createServer';
import { getScenario } from '../../../index';
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
      // A 2026-07-28 request that leaves out the protocol-version header.
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
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
          method: 'tools/list',
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

  it('notes a legacy initialize as INFO, not as a rejected request', async () => {
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
      // A dual-era client falling back to the initialize handshake.
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(legacyInitialize)
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatchObject({
        code: -32022,
        data: { supported: [DRAFT_PROTOCOL_VERSION] }
      });
      expect(checks.some((c) => c.id === 'stateless-request-rejected')).toBe(
        false
      );
      expect(checks.filter((c) => c.id === 'stateless-legacy-probe')).toEqual([
        expect.objectContaining({
          status: 'INFO',
          details: expect.objectContaining({
            status: 400,
            code: -32022,
            requestedVersion: '2025-11-25'
          })
        })
      ]);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not fail a 2026-07-28 auth scenario whose client falls back to initialize', async () => {
    // The request sequence the C# SDK sent to auth/iss-supported: a
    // server/discover probe, then (after its probe window ran out during
    // authorization) initialize, then initialize again with the token.
    const scenario = getScenario('auth/iss-supported')!;
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    const post = (body: unknown, token?: string) =>
      fetch(serverUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token && { authorization: `Bearer ${token}` })
        },
        body: JSON.stringify(body)
      });
    try {
      const discover = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION
          }
        }
      });
      expect(discover.status).toBe(401);
      expect((await post(legacyInitialize)).status).toBe(401);
      const withToken = await post(legacyInitialize, 'test-token-dual-era');
      expect(withToken.status).toBe(400);
      expect((await withToken.json()).error.code).toBe(-32022);

      const checks = scenario.getChecks();
      expect(checks.some((c) => c.id === 'stateless-request-rejected')).toBe(
        false
      );
      expect(
        checks.find((c) => c.id === 'stateless-legacy-probe')
      ).toMatchObject({ status: 'INFO' });
    } finally {
      await scenario.stop();
    }
  });
});

const legacyInitialize = {
  jsonrpc: '2.0',
  id: 2,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'dual-era-client', version: '1.0.0' }
  }
};
