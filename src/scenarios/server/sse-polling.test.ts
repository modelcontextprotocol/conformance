import { describe, test, expect } from 'vitest';
import http from 'http';
import { testContext } from '../../connection/testing';
import { ServerSSEPollingScenario } from './sse-polling';
import { LATEST_SPEC_VERSION, type ConformanceCheck } from '../../types';

// Regression coverage for the #412 bug class in sse-polling: raw follow-up
// requests must carry the initialize-negotiated protocol version and session
// id, enforced by a fixture that down-negotiates and 400s mismatched requests.

const SESSION_ID = 'test-session-sse-polling';
const DOWN_NEGOTIATED_VERSION = '2025-06-18';

interface SeenRequest {
  request: string;
  version: string | undefined;
  hasLastEventId?: boolean;
}

interface VersionEnforcingServer {
  url: string;
  seenRequests: () => SeenRequest[];
  close: () => Promise<void>;
}

// Down-negotiates every initialize to DOWN_NEGOTIATED_VERSION so a scenario
// that hard-codes the latest version cannot pass, records each follow-up's
// version header, and 400s any version or session mismatch.
async function startVersionEnforcingServer(
  supportsReconnectionTool = true
): Promise<VersionEnforcingServer> {
  let negotiated: string | undefined;
  const seen: SeenRequest[] = [];

  const server = http.createServer((req, res) => {
    const rawVersion = req.headers['mcp-protocol-version'];
    const version = Array.isArray(rawVersion) ? rawVersion[0] : rawVersion;
    const sessionOk = req.headers['mcp-session-id'] === SESSION_ID;
    const sseHead = { 'Content-Type': 'text/event-stream' };
    const reject = (payload: object) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const mismatchError = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: `Session or protocol version mismatch: got ${version}, negotiated ${negotiated}`
      }
    };

    if (req.method === 'GET') {
      seen.push({
        request: 'GET',
        version,
        hasLastEventId: Boolean(req.headers['last-event-id'])
      });
      if (version !== negotiated || !sessionOk) {
        reject(mismatchError);
        return;
      }
      if (!req.headers['last-event-id']) {
        // Absorbs the SDK's automatic standalone GET after initialized;
        // the SDK tolerates 405, and the scenario's reconnect GET differs
        // by carrying Last-Event-ID.
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      res.writeHead(200, sseHead);
      res.end(
        'id: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'
      );
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
        negotiated = DOWN_NEGOTIATED_VERSION;
        res.setHeader('mcp-session-id', SESSION_ID);
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

      seen.push({ request: body.method ?? 'unknown', version });
      if (version !== negotiated || !sessionOk) {
        reject({ ...mismatchError, id: body.id ?? null });
        return;
      }

      if (body.method === 'notifications/initialized') {
        respond(202);
        return;
      }
      if (body.method === 'tools/call') {
        if (!supportsReconnectionTool) {
          respond(404, {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Tool not found' }
          });
          return;
        }
        // Spec-shaped priming event (id + empty data), then close without
        // the result, so the scenario must reconnect via GET + Last-Event-ID.
        res.writeHead(200, sseHead);
        res.end('id: evt-1\ndata: \n\n');
        return;
      }
      respond(404, {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32601, message: 'Not found' }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenRequests: () => seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

const findAll = (checks: ConformanceCheck[], id: string) =>
  checks.filter((c) => c.id === id);

describe('server-sse-polling — negotiated protocol version', () => {
  test('raw POST and GET carry the down-negotiated version', async () => {
    const srv = await startVersionEnforcingServer();

    const scenario = new ServerSSEPollingScenario();
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run(testContext(srv.url, LATEST_SPEC_VERSION));
    } finally {
      await srv.close();
    }

    // Both raw sites must have fired and sent the negotiated version, not
    // the latest/spec version.
    const toolCalls = srv
      .seenRequests()
      .filter((s) => s.request === 'tools/call');
    const reconnectGets = srv
      .seenRequests()
      .filter((s) => s.request === 'GET' && s.hasLastEventId);
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(reconnectGets.length).toBeGreaterThanOrEqual(1);
    expect(
      [...toolCalls, ...reconnectGets].filter(
        (s) => s.version !== DOWN_NEGOTIATED_VERSION
      )
    ).toEqual([]);

    const resume = findAll(checks, 'server-sse-disconnect-resume')[0];
    expect(resume?.status).toBe('SUCCESS');
    expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
  });

  test('reports an unavailable fixture tool as diagnostic information', async () => {
    const srv = await startVersionEnforcingServer(false);

    let checks: ConformanceCheck[];
    try {
      checks = await new ServerSSEPollingScenario().run(
        testContext(srv.url, LATEST_SPEC_VERSION)
      );
    } finally {
      await srv.close();
    }

    expect(
      findAll(checks, 'server-sse-test-reconnection-tool')[0]
    ).toMatchObject({
      status: 'INFO',
      details: { statusCode: 404 }
    });
    expect(checks.some((check) => check.status === 'WARNING')).toBe(false);
    expect(checks.some((check) => check.status === 'FAILURE')).toBe(false);
  });

  test('fixture rejects a supported but non-negotiated version', async () => {
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
            protocolVersion: LATEST_SPEC_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        })
      });
      expect(init.status).toBe(200);

      const callWith = (version: string) =>
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
            method: 'tools/call',
            params: { name: 'test_reconnection', arguments: {} }
          })
        });

      // The latest version is valid MCP but was not negotiated above.
      const rejected = await callWith(LATEST_SPEC_VERSION);
      expect(rejected.status).toBe(400);

      const accepted = await callWith(DOWN_NEGOTIATED_VERSION);
      expect(accepted.status).toBe(200);
      await accepted.body?.cancel();
    } finally {
      await srv.close();
    }
  });
});
