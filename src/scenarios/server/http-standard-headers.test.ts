import { describe, test, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import http from 'http';
import net from 'net';
import { testContext } from '../../connection/testing';
import { withRequestMeta } from '../../connection';
import {
  takeWireViolations,
  withWireRecorder,
  wireSchemaChecks
} from '../../validation/wire-schema';
import {
  HttpHeaderValidationScenario,
  HttpCustomHeaderServerValidationScenario,
  CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS,
  sendRawRequest
} from './http-standard-headers';
import { DRAFT_PROTOCOL_VERSION, type ConformanceCheck } from '../../types';

/**
 * Pins the untestable-failure policy (issue #248) for the SEP-2243 server
 * scenarios: a server that lacks the fixtures these scenarios need must read
 * red with a "Not testable:" cause, never as a green SKIPPED run.
 */

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

function mockFetchTarget(
  handler: (reqBody: any, reqHeaders: HeadersInit) => any
) {
  global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body?.toString() ?? '');
    const headers = init?.headers || {};
    const responseConfig = (await handler(body, headers)) ?? {
      status: 404,
      body: {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Not found' }
      }
    };
    const text = JSON.stringify(responseConfig.body);
    return new Response(text, {
      status: responseConfig.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return 'http://mock-sep2243-server.local';
}

const findAll = (checks: ConformanceCheck[], id: string) =>
  checks.filter((c) => c.id === id);

describe('http-custom-header-server-validation — missing fixture policy', () => {
  test('emits untestable FAILUREs for every declared check when no x-mcp-header tool exists', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'tools/list') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: {
              resultType: 'complete',
              ttlMs: 0,
              cacheScope: 'private',
              tools: [
                {
                  name: 'plain_tool',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      enabled: true,
                      q: { type: ['string', 'null'] }
                    }
                  }
                }
              ]
            }
          }
        };
      }
    });

    const scenario = new HttpCustomHeaderServerValidationScenario();
    const checks = await scenario.run(
      testContext(mockUrl, DRAFT_PROTOCOL_VERSION)
    );

    const gate = findAll(checks, 'sep-2243-server-no-xmcp-tool')[0];
    expect(gate?.status).toBe('FAILURE');
    expect(gate?.errorMessage).toContain('Not testable:');

    for (const id of CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS) {
      const declared = findAll(checks, id)[0];
      expect(declared?.status, id).toBe('FAILURE');
      expect(declared?.errorMessage, id).toContain('Not testable:');
      expect(declared?.details, id).toMatchObject({ untestable: true });
    }

    // The run must not contain a single SKIPPED row: the whole point is
    // that this server cannot collect a vacuous green.
    expect(checks.every((c) => c.status !== 'SKIPPED')).toBe(true);
  });

  test('emits untestable FAILUREs when the annotated tool has no string parameter', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'tools/list') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: {
              resultType: 'complete',
              ttlMs: 0,
              cacheScope: 'private',
              tools: [
                {
                  name: 'numeric_only',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      level: { type: 'number', 'x-mcp-header': 'Level' }
                    }
                  }
                }
              ]
            }
          }
        };
      }
    });

    const scenario = new HttpCustomHeaderServerValidationScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const gate = findAll(checks, 'sep-2243-server-no-string-param')[0];
    expect(gate?.status).toBe('FAILURE');
    expect(gate?.errorMessage).toContain('Not testable:');
    for (const id of CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS) {
      expect(findAll(checks, id)[0]?.status, id).toBe('FAILURE');
    }
  });
});

describe('http-header-validation — zero-tools Mcp-Name cases', () => {
  // This scenario sends its live cases over raw node http (not fetch), so it
  // is driven against a real local server rather than a fetch mock.
  async function startBareServer(
    handler: (body: any) => { status: number; body: object }
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: any = {};
        try {
          body = JSON.parse(raw);
        } catch {
          // Treat unparseable bodies as empty requests.
        }
        const out = handler(body);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    // SAFETY: server.listen(0) resolves after the server has a TCP address.
    const address = server.address() as AddressInfo;
    const port = address.port;
    return {
      url: `http://localhost:${port}/mcp`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    };
  }

  test('emits untestable FAILUREs for the Mcp-Name cases when the server lists no tools', async () => {
    const srv = await startBareServer((body) => {
      if (body.method === 'tools/list') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              resultType: 'complete',
              ttlMs: 0,
              cacheScope: 'private',
              tools: []
            }
          }
        };
      }
      return {
        status: 400,
        body: {
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32020, message: 'Header mismatch' }
        }
      };
    });

    const scenario = new HttpHeaderValidationScenario();
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run(testContext(srv.url));
    } finally {
      await srv.close();
    }

    // Previously these three cases were silently omitted; now each surfaces
    // as an untestable FAILURE naming the missing prerequisite.
    const whitespace = findAll(
      checks,
      'sep-2243-server-accepts-whitespace-header-value'
    );
    expect(whitespace.length).toBeGreaterThan(0);
    expect(whitespace[0].status).toBe('FAILURE');
    expect(whitespace[0].errorMessage).toContain('Not testable:');

    const nameRejects = findAll(
      checks,
      'sep-2243-server-reject-invalid-headers'
    ).filter((c) => c.errorMessage?.startsWith('Not testable:'));
    expect(nameRejects.map((c) => c.name).sort()).toEqual([
      'ServerRejectsMismatchedNameHeader',
      'ServerRejectsMissingNameHeader'
    ]);
  });

  test('emits untestable FAILUREs for the Mcp-Name cases when tools/list discovery fails', async () => {
    const srv = await startBareServer((body) => ({
      status: 500,
      body: {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: 'boom' }
      }
    }));

    const scenario = new HttpHeaderValidationScenario();
    let checks: ConformanceCheck[];
    try {
      checks = await scenario.run(testContext(srv.url));
    } finally {
      await srv.close();
    }

    const setup = findAll(checks, 'sep-2243-server-standard-setup')[0];
    expect(setup?.status).toBe('FAILURE');
    const whitespace = findAll(
      checks,
      'sep-2243-server-accepts-whitespace-header-value'
    )[0];
    expect(whitespace?.status).toBe('FAILURE');
    expect(whitespace?.errorMessage).toContain('Not testable:');
  });
});

interface RawFixtureRequest {
  id?: number | string | null;
  method?: string;
}

interface RawFixtureInput {
  body: RawFixtureRequest;
  rawHeaders: string[];
}

interface RawFixtureReply {
  status: number;
  body?: RawResponse | RawErrorResponse | RawInvalidEnvelopeResponse;
  contentType?: string;
  rawBody?: string;
  sseChunks?: string[];
  keepOpen?: boolean;
}

type RawResponse =
  | {
      jsonrpc: '2.0';
      id: number | string | null;
      result: {
        tools: [] | string;
        resultType: 'complete';
        ttlMs: 0;
        cacheScope: 'private';
      };
    }
  | {
      jsonrpc: '2.0';
      id: number | string | null;
      error: { code: -32020; message: string };
    };

interface RawErrorResponse {
  jsonrpc: '2.0';
  error: { code: -32020; message: string };
}

interface RawInvalidEnvelopeResponse {
  jsonrpc: '1.0';
  id: number | string | null;
  result: {
    tools: [];
    resultType: 'complete';
    ttlMs: 0;
    cacheScope: 'private';
  };
}

interface RawFixture {
  url: string;
  responseClosed: Promise<void>;
  close: () => Promise<void>;
}

interface RawSocketFixture {
  url: string;
  requestBytes: Promise<string>;
  close: () => Promise<void>;
}

function validToolsListResponse(
  id: number | string | null | undefined,
  tools: [] | string = []
): RawResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      tools,
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private'
    }
  };
}

function errorResponse(id: number | string | null): RawResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32020, message: 'Header mismatch' }
  };
}

function errorWithoutId(): RawErrorResponse {
  return {
    jsonrpc: '2.0',
    error: { code: -32020, message: 'Header mismatch' }
  };
}

async function startRawFixture(
  handler: (
    input: RawFixtureInput
  ) => RawFixtureReply | Promise<RawFixtureReply>
): Promise<RawFixture> {
  let resolveResponseClosed: () => void = () => {};
  const responseClosed = new Promise<void>((resolve) => {
    resolveResponseClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    res.once('close', resolveResponseClosed);
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', async () => {
      // SAFETY: every request in these fixtures is a JSON-RPC object.
      const body = JSON.parse(raw) as RawFixtureRequest;
      const reply = await handler({ body, rawHeaders: req.rawHeaders });
      if (reply.sseChunks) {
        res.writeHead(reply.status, { 'Content-Type': 'text/event-stream' });
        for (const chunk of reply.sseChunks) {
          res.write(chunk);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!reply.keepOpen) res.end();
        return;
      }
      res.writeHead(reply.status, {
        'Content-Type': reply.contentType ?? 'application/json'
      });
      res.end(reply.rawBody ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: server.listen(0) resolves after the server has a TCP address.
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    responseClosed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

async function waitForBounded(
  signal: Promise<void>,
  timeoutMessage: string
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<void>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(timeoutMessage)),
          1000
        );
      })
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

const waitForResponseClosed = (responseClosed: Promise<void>) =>
  waitForBounded(responseClosed, 'fixture response did not close');

async function startRawSocketFixture(): Promise<RawSocketFixture> {
  let resolveRequestBytes: (value: string) => void = () => {};
  const requestBytes = new Promise<string>((resolve) => {
    resolveRequestBytes = resolve;
  });
  const server = net.createServer((socket) => {
    let raw = '';
    let replied = false;
    socket.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      if (separator < 0 || replied) return;
      const headerBlock = raw.slice(0, separator);
      const lengthMatch = headerBlock.match(/\r\ncontent-length:\s*(\d+)/i);
      const bodyLength = lengthMatch ? Number(lengthMatch[1]) : 0;
      const bodyStart = separator + 4;
      if (Buffer.byteLength(raw.slice(bodyStart), 'utf8') < bodyLength) return;
      replied = true;
      resolveRequestBytes(raw);
      const responseBody = JSON.stringify(validToolsListResponse('socket'));
      socket.end(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(responseBody)}\r\n` +
          'Connection: close\r\n\r\n' +
          responseBody
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: server.listen(0) resolves after the server has a TCP address.
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requestBytes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

describe('sendRawRequest wire observation', () => {
  test('records valid JSON request and response as two observations', async () => {
    const fixture = await startRawFixture(({ body }) => ({
      status: 200,
      body: validToolsListResponse(body.id)
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'json-valid',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.status).toBe(200);
      expect(result.wire.observed).toBe(2);
      expect(result.wire.violations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('records harness and implementation violations in separate scopes', async () => {
    let signalSecondSeen: () => void = () => {};
    const secondSeen = new Promise<void>((resolve) => {
      signalSecondSeen = resolve;
    });
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const fixture = await startRawFixture(async ({ body }) => {
      if (body.id === 'invalid-response') {
        signalSecondSeen();
        await secondGate;
      }
      return {
        status: 200,
        body:
          body.id === 'invalid-request'
            ? validToolsListResponse(body.id)
            : validToolsListResponse(body.id, 'invalid-tools')
      };
    });
    const implementationPromise = withWireRecorder(async () => {
      await sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
        jsonrpc: '2.0',
        id: 'invalid-response',
        method: 'tools/list',
        params: withRequestMeta({})
      });
      return takeWireViolations();
    });
    try {
      await waitForBounded(secondSeen, 'second fixture response did not start');
      // Drain the first scope while the second scope has an observed request
      // and is still waiting for its response.
      const harness = await withWireRecorder(async () => {
        await sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
          jsonrpc: '2.0',
          id: 'invalid-request',
          method: 'tools/list',
          params: 'invalid'
        });
        return takeWireViolations();
      });
      releaseSecond();
      const implementation = await implementationPromise;

      expect(harness.observed).toBe(2);
      expect(harness.violations).toHaveLength(1);
      expect(harness.violations[0]?.origin).toBe('harness');
      expect(implementation.observed).toBe(2);
      expect(implementation.violations).toHaveLength(1);
      expect(implementation.violations[0]?.origin).toBe('implementation');
    } finally {
      releaseSecond();
      await implementationPromise.catch(() => undefined);
      await fixture.close();
    }
  });

  test('rejects a JSON response with a different request ID', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      body: validToolsListResponse('other-id')
    }));
    try {
      const result = await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'expected-id',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('did not contain the response');
        return takeWireViolations();
      });

      expect(result.observed).toBe(2);
      expect(result.violations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('keeps an error response without an ID observable', async () => {
    const fixture = await startRawFixture(() => ({
      status: 400,
      body: errorWithoutId()
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'error-without-id',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.status).toBe(400);
      expect(result.response.body).toMatchObject({ error: { code: -32020 } });
      expect(result.wire.observed).toBe(2);
      expect(result.wire.violations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('preserves an empty rejected body without fabricating JSON-RPC', async () => {
    const fixture = await startRawFixture(() => ({
      status: 400,
      contentType: 'application/json',
      rawBody: ''
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'empty-rejection',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.status).toBe(400);
      expect(result.response.body).toBeUndefined();
      expect(result.wire.observed).toBe(1);
      expect(result.wire.violations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('reports non-JSON successful bodies as an observation failure', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      contentType: 'text/plain',
      rawBody: 'not-json'
    }));
    try {
      const wire = await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'plain-success',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('did not contain');
        return takeWireViolations();
      });
      expect(wire.observed).toBe(1);
      expect(wire.violations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    ['', 'before the response'],
    ['{', 'malformed JSON']
  ])(
    'reports invalid successful JSON body %j as an observation failure',
    async (rawBody, reason) => {
      const fixture = await startRawFixture(() => ({
        status: 200,
        contentType: 'application/json',
        rawBody
      }));
      try {
        const wire = await withWireRecorder(async () => {
          await expect(
            sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
              jsonrpc: '2.0',
              id: 'malformed-json',
              method: 'tools/list',
              params: withRequestMeta({})
            })
          ).rejects.toThrow(reason);
          return takeWireViolations();
        });
        expect(wire.observed).toBe(1);
        expect(wire.violations).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    }
  );

  test('records an invalid JSON-RPC envelope without rejecting the response', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      body: {
        jsonrpc: '1.0',
        id: 'invalid-envelope',
        result: {
          tools: [],
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private'
        }
      }
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'invalid-envelope',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.body).toMatchObject({
        jsonrpc: '1.0',
        id: 'invalid-envelope'
      });
      expect(result.wire.observed).toBe(2);
      expect(result.wire.violations).toHaveLength(1);
      expect(result.wire.violations[0]).toMatchObject({
        origin: 'implementation',
        context: 'raw HTTP response',
        message: { jsonrpc: '1.0', id: 'invalid-envelope' }
      });
    } finally {
      await fixture.close();
    }
  });

  test('distinguishes numeric and string response IDs', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      body: validToolsListResponse('7')
    }));
    try {
      await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('did not contain the response');
        takeWireViolations();
      });
    } finally {
      await fixture.close();
    }
  });

  test('parses split SSE frames and returns after the matching response', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      keepOpen: true,
      sseChunks: [
        ': comment\nretry: 50\nid: prime\ndata:\n\n',
        'id: event-1\ndata: {"jsonrpc":"2.0","id":"sse-valid",',
        '"result":{"tools":[],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}\n\n'
      ]
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'sse-valid',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.status).toBe(200);
      expect(result.response.body).toMatchObject({ id: 'sse-valid' });
      expect(result.wire.observed).toBe(2);
      expect(result.wire.violations).toHaveLength(0);
      await waitForResponseClosed(fixture.responseClosed);
    } finally {
      await fixture.close();
    }
  });

  test('records an invalid SSE method result without rejecting the response', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      keepOpen: true,
      sseChunks: [
        'data: {"jsonrpc":"2.0","id":"sse-invalid","result":{"tools":"invalid-tools","resultType":"complete","ttlMs":0,"cacheScope":"private"}}\n\n'
      ]
    }));
    try {
      const result = await withWireRecorder(async () => {
        const response = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'sse-invalid',
            method: 'tools/list',
            params: withRequestMeta({})
          }
        );
        return { response, wire: takeWireViolations() };
      });

      expect(result.response.body).toMatchObject({ id: 'sse-invalid' });
      expect(result.wire.observed).toBe(2);
      expect(result.wire.violations).toHaveLength(1);
      expect(result.wire.violations[0]?.origin).toBe('implementation');
    } finally {
      await fixture.close();
    }
  });

  test('fails a closed SSE stream without a final response', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      sseChunks: []
    }));
    try {
      const wire = await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'sse-missing',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('before the response');
        return takeWireViolations();
      });
      expect(wire.observed).toBe(1);
      await waitForResponseClosed(fixture.responseClosed);
    } finally {
      await fixture.close();
    }
  });

  test('cleans up an SSE stream when the observation deadline expires', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      keepOpen: true,
      sseChunks: [': waiting\n\n']
    }));
    try {
      const wire = await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'sse-timeout',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('observation deadline');
        return takeWireViolations();
      });
      expect(wire.observed).toBe(1);
      await waitForResponseClosed(fixture.responseClosed);
    } finally {
      await fixture.close();
    }
  }, 15000);

  test('stops after the bounded SSE event count', async () => {
    const chunks = Array.from(
      { length: 101 },
      (_value, index) =>
        `data: {"jsonrpc":"2.0","id":"other-${index}","result":{"tools":[],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}\n\n`
    );
    const fixture = await startRawFixture(() => ({
      status: 200,
      sseChunks: chunks
    }));
    try {
      await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'sse-bounded-events',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('observation limit');
        takeWireViolations();
      });
    } finally {
      await fixture.close();
    }
  });

  test('stops after the bounded SSE byte count', async () => {
    const fixture = await startRawFixture(() => ({
      status: 200,
      sseChunks: [`data: ${'x'.repeat(1024 * 1024)}\n\n`]
    }));
    try {
      await withWireRecorder(async () => {
        await expect(
          sendRawRequest(fixture.url, DRAFT_PROTOCOL_VERSION, {
            jsonrpc: '2.0',
            id: 'sse-bounded-bytes',
            method: 'tools/list',
            params: withRequestMeta({})
          })
        ).rejects.toThrow('observation limit');
        takeWireViolations();
      });
    } finally {
      await fixture.close();
    }
  });
});

describe('http-header-validation — raw response observation regression', () => {
  test('reports only the malformed lowercase-header response', async () => {
    let requestCount = 0;
    let lowercaseRequestId: RawFixtureRequest['id'];
    const capturedHeaderNames: string[][] = [];
    const fixture = await startRawFixture(({ body, rawHeaders }) => {
      capturedHeaderNames.push(
        rawHeaders.filter((_value, index) => index % 2 === 0)
      );
      const isSetup = requestCount === 0;
      requestCount += 1;
      if (isSetup) {
        return { status: 200, body: validToolsListResponse(body.id) };
      }

      const methodHeaderIndex = rawHeaders.findIndex(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === 'mcp-method'
      );
      const methodHeader =
        methodHeaderIndex >= 0 ? rawHeaders[methodHeaderIndex + 1] : undefined;
      if (methodHeader !== body.method) {
        return { status: 400, body: errorResponse(body.id ?? null) };
      }
      if (
        methodHeader === 'tools/list' &&
        rawHeaders[methodHeaderIndex] === 'mcp-method'
      ) {
        lowercaseRequestId = body.id;
        return {
          status: 200,
          body: validToolsListResponse(body.id, 'invalid-tools')
        };
      }
      return { status: 200, body: validToolsListResponse(body.id) };
    });

    try {
      const result = await withWireRecorder(async () => {
        const checks = await new HttpHeaderValidationScenario().run(
          testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
        );
        return { checks, wire: wireSchemaChecks(DRAFT_PROTOCOL_VERSION) };
      });

      const wireCheck = result.wire.find(
        (check) => check.id === 'wire-schema-valid'
      );
      expect(wireCheck?.status).toBe('FAILURE');
      expect(wireCheck?.errorMessage).toContain('tools/list');
      expect(lowercaseRequestId).toBeDefined();
      expect(requestCount).toBe(6);
      expect(wireCheck?.details?.violations).toHaveLength(1);
      expect(wireCheck?.details).toMatchObject({
        messagesValidated: 12,
        violations: [
          {
            origin: 'implementation',
            context: 'raw HTTP response',
            message: {
              id: lowercaseRequestId,
              result: { tools: 'invalid-tools' }
            }
          }
        ]
      });
      expect(
        result.wire.some((check) => check.id === 'wire-schema-harness-error')
      ).toBe(false);
      expect(
        result.checks.find(
          (check) => check.name === 'ServerAcceptsLowercaseHeaderName'
        )?.status
      ).toBe('SUCCESS');
      expect(
        result.checks.find(
          (check) => check.name === 'ServerAcceptsUppercaseHeaderName'
        )?.status
      ).toBe('SUCCESS');
      expect(
        capturedHeaderNames.some((headers) => headers.includes('mcp-method'))
      ).toBe(true);
      expect(
        capturedHeaderNames.some((headers) => headers.includes('MCP-METHOD'))
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe('sendRawRequest exact header bytes', () => {
  test('preserves leading and trailing header whitespace on the socket', async () => {
    const fixture = await startRawSocketFixture();
    try {
      const response = await withWireRecorder(async () => {
        const result = await sendRawRequest(
          fixture.url,
          DRAFT_PROTOCOL_VERSION,
          {
            jsonrpc: '2.0',
            id: 'socket',
            method: 'tools/list',
            params: withRequestMeta({})
          },
          { 'Mcp-Name': '  edge-value  ' }
        );
        takeWireViolations();
        return result;
      });
      const requestBytes = await fixture.requestBytes;

      expect(response.status).toBe(200);
      expect(requestBytes).toContain('Mcp-Name:   edge-value  \r\n');
    } finally {
      await fixture.close();
    }
  });
});
