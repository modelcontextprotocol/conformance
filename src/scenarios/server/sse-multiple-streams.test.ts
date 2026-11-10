import { describe, test, expect } from 'vitest';
import http from 'http';
import { testContext } from '../../connection/testing';
import { ServerSSEMultipleStreamsScenario } from './sse-multiple-streams';
import type { ConformanceCheck } from '../../types';

/**
 * Regression coverage for issue #412: the stateful scenario must send the
 * protocol version negotiated during initialize on its raw follow-up POSTs,
 * not a hard-coded historical revision. The fixture server below stores the
 * version it returned from initialize and rejects (400) any later request
 * whose MCP-Protocol-Version header does not match it.
 */

const SESSION_ID = 'test-session-412';

interface VersionEnforcingServer {
  url: string;
  negotiatedVersion: () => string | undefined;
  close: () => Promise<void>;
}

async function startVersionEnforcingServer(
  useSession = true
): Promise<VersionEnforcingServer> {
  let negotiated: string | undefined;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: {
        id?: number | string;
        method?: string;
        params?: { protocolVersion?: string };
      } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Treat unparseable bodies as empty requests.
      }
      const respond = (status: number, payload?: object) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload ? JSON.stringify(payload) : undefined);
      };

      if (body.method === 'initialize') {
        negotiated = body.params?.protocolVersion;
        if (useSession) {
          res.setHeader('mcp-session-id', SESSION_ID);
        }
        respond(200, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: negotiated,
            capabilities: {},
            serverInfo: { name: 'version-enforcing-server', version: '1.0.0' }
          }
        });
        return;
      }

      if (req.headers['mcp-protocol-version'] !== negotiated) {
        respond(400, {
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32000, message: 'Protocol version mismatch' }
        });
        return;
      }

      if (body.method === 'notifications/initialized') {
        respond(202);
        return;
      }
      if (body.method === 'tools/list') {
        respond(200, { jsonrpc: '2.0', id: body.id, result: { tools: [] } });
        return;
      }
      respond(404, {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32601, message: 'Not found' }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}/mcp`,
    negotiatedVersion: () => negotiated,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

const findAll = (checks: ConformanceCheck[], id: string) =>
  checks.filter((c) => c.id === id);

describe('server-sse-multiple-streams — negotiated protocol version', () => {
  test('passes against a server that rejects non-negotiated versions', async () => {
    const srv = await startVersionEnforcingServer();

    const scenario = new ServerSSEMultipleStreamsScenario();
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run(testContext(srv.url));
    } finally {
      await srv.close();
    }

    // The scenario negotiated a current version, not the old hard-coded pin.
    expect(srv.negotiatedVersion()).toBeDefined();
    expect(srv.negotiatedVersion()).not.toBe('2025-03-26');

    const accepted = findAll(checks, 'server-accepts-multiple-post-streams')[0];
    expect(accepted?.status).toBe('SUCCESS');
    expect(accepted?.details).toMatchObject({
      numStreamsAttempted: 3,
      numStreamsAccepted: 3
    });
    expect(checks.every((c) => c.status !== 'FAILURE')).toBe(true);
  });

  test('keeps a conformant sessionless server green and exercises its requests', async () => {
    const srv = await startVersionEnforcingServer(false);

    const scenario = new ServerSSEMultipleStreamsScenario();
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run(testContext(srv.url));
    } finally {
      await srv.close();
    }

    expect(
      findAll(checks, 'server-sse-multiple-streams-session')[0]?.status
    ).toBe('INFO');
    expect(
      findAll(checks, 'server-accepts-multiple-post-streams')[0]?.status
    ).toBe('SUCCESS');
    expect(checks.some((check) => check.status === 'WARNING')).toBe(false);
    expect(checks.some((check) => check.status === 'FAILURE')).toBe(false);
  });

  test('fixture server rejects a supported but non-negotiated version', async () => {
    const srv = await startVersionEnforcingServer();

    try {
      const init = await fetch(srv.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        })
      });
      expect(init.status).toBe(200);

      const listWith = (version: string) =>
        fetch(srv.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
            'mcp-session-id': SESSION_ID,
            'mcp-protocol-version': version
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {}
          })
        });

      // The old hard-coded pin is a valid MCP version but not the one
      // negotiated above, so this fixture must reject it.
      const rejected = await listWith('2025-03-26');
      expect(rejected.status).toBe(400);

      const acceptedRes = await listWith('2025-11-25');
      expect(acceptedRes.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
