/**
 * Unit tests for the shared stateless request helper (SEP-2575 + SEP-2243):
 * unsupported-version retry guard, SSE response handling, header/_meta
 * protocol-version sync, and standard header defaults/omission.
 */
import http from 'http';
import { describe, test, expect, afterEach } from 'vitest';
import { sendStatelessRequest } from './stateless-client';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface StubServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function startStubServer(
  handler: (
    recorded: RecordedRequest,
    requestIndex: number,
    res: http.ServerResponse
  ) => void
): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const recorded: RecordedRequest = {
        headers: req.headers,
        body: JSON.parse(body)
      };
      requests.push(recorded);
      handler(recorded, requests.length, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://localhost:${port}/`,
        requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            // Tear down any SSE connections deliberately left open by a test.
            server.closeAllConnections();
            server.close(() => resolveClose());
          })
      });
    });
  });
}

function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('sendStatelessRequest', () => {
  let stub: StubServer | undefined;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = undefined;
    }
  });

  test('does not retry a 400 whose error code is not a version rejection', async () => {
    stub = await startStubServer((recorded, _index, res) => {
      // 400 with an unrelated error code whose data happens to carry an array
      // named "supported" — must NOT be treated as a version rejection.
      respondJson(res, 400, {
        jsonrpc: '2.0',
        id: recorded.body.id,
        error: {
          code: -32099,
          message: 'scope rejected',
          data: { supported: ['something-unrelated'] }
        }
      });
    });

    const response = await sendStatelessRequest(stub.url, 'tools/list');

    expect(stub.requests).toHaveLength(1);
    expect(response.status).toBe(400);
    expect(response.body?.error?.code).toBe(-32099);
    expect(response.body?.error?.message).toBe('scope rejected');
    expect(response.versionRetry).toBeUndefined();
  });

  test('retries exactly once with the supported version on a -32004 rejection', async () => {
    stub = await startStubServer((recorded, index, res) => {
      if (index === 1) {
        respondJson(res, 400, {
          jsonrpc: '2.0',
          id: recorded.body.id,
          error: {
            code: -32004,
            message: 'Unsupported protocol version',
            data: { supported: [DRAFT_PROTOCOL_VERSION] }
          }
        });
        return;
      }
      respondJson(res, 200, {
        jsonrpc: '2.0',
        id: recorded.body.id,
        result: { ok: true }
      });
    });

    const response = await sendStatelessRequest(stub.url, 'tools/list');

    expect(stub.requests).toHaveLength(2);
    const retryRequest = stub.requests[1];
    expect(retryRequest.headers['mcp-protocol-version']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
    expect(retryRequest.body.params._meta[PROTOCOL_VERSION_META_KEY]).toBe(
      DRAFT_PROTOCOL_VERSION
    );
    // The retry reuses the original JSON-RPC id.
    expect(retryRequest.body.id).toBe(stub.requests[0].body.id);

    expect(response.status).toBe(200);
    expect(response.body?.result).toEqual({ ok: true });
    expect(response.versionRetry).toEqual({
      rejectedStatus: 400,
      rejectedError: { code: -32004, message: 'Unsupported protocol version' },
      retriedWith: DRAFT_PROTOCOL_VERSION
    });
  });

  test('resolves promptly when an SSE response keeps the stream open', async () => {
    stub = await startStubServer((recorded, _index, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      // The matching JSON-RPC response is written immediately, but the stream
      // is deliberately never ended.
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: recorded.body.id,
          result: { ok: true }
        })}\n\n`
      );
    });

    const started = Date.now();
    const response = await sendStatelessRequest(stub.url, 'tools/list');
    const elapsed = Date.now() - started;

    // Must resolve as soon as the matching event arrives, not on the timeout.
    expect(elapsed).toBeLessThan(1000);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(response.body?.result).toEqual({ ok: true });
    expect(response.events?.length).toBeGreaterThanOrEqual(1);
  });

  test('keeps the MCP-Protocol-Version header in sync with a _meta version override', async () => {
    stub = await startStubServer((recorded, _index, res) => {
      respondJson(res, 200, {
        jsonrpc: '2.0',
        id: recorded.body.id,
        result: {}
      });
    });

    await sendStatelessRequest(stub.url, 'tools/list', undefined, {
      meta: { [PROTOCOL_VERSION_META_KEY]: '2025-11-25' },
      retryOnUnsupportedVersion: false
    });

    expect(stub.requests).toHaveLength(1);
    const recorded = stub.requests[0];
    expect(recorded.body.params._meta[PROTOCOL_VERSION_META_KEY]).toBe(
      '2025-11-25'
    );
    expect(recorded.headers['mcp-protocol-version']).toBe('2025-11-25');
  });

  test('sends the standard headers and _meta by default and honors omitHeaders', async () => {
    stub = await startStubServer((recorded, _index, res) => {
      respondJson(res, 200, {
        jsonrpc: '2.0',
        id: recorded.body.id,
        result: { content: [] }
      });
    });

    await sendStatelessRequest(stub.url, 'tools/call', {
      name: 'echo_tool',
      arguments: {}
    });

    const conformant = stub.requests[0];
    expect(conformant.headers['mcp-method']).toBe('tools/call');
    expect(conformant.headers['mcp-name']).toBe('echo_tool');
    expect(conformant.headers['mcp-protocol-version']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
    expect(conformant.headers['content-type']).toBe('application/json');
    expect(conformant.headers['accept']).toContain('application/json');
    expect(conformant.headers['accept']).toContain('text/event-stream');

    const meta = conformant.body.params._meta;
    expect(meta[PROTOCOL_VERSION_META_KEY]).toBe(DRAFT_PROTOCOL_VERSION);
    expect(meta['io.modelcontextprotocol/clientInfo']).toMatchObject({
      name: expect.any(String),
      version: expect.any(String)
    });
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toMatchObject({
      sampling: {},
      elicitation: {},
      roots: { listChanged: true }
    });

    await sendStatelessRequest(
      stub.url,
      'tools/call',
      { name: 'echo_tool', arguments: {} },
      { omitHeaders: ['Mcp-Method', 'Mcp-Name'] }
    );

    const stripped = stub.requests[1];
    expect(stripped.headers['mcp-method']).toBeUndefined();
    expect(stripped.headers['mcp-name']).toBeUndefined();
    // Untouched defaults are still sent.
    expect(stripped.headers['mcp-protocol-version']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
  });
});
