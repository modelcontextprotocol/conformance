/**
 * Tests for the server-conformance runner: spec-version applicability
 * skipping (an explicitly-requested version outside a scenario's window
 * skips rather than silently testing something else; --force overrides).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, test, expect } from 'vitest';
import { runServerConformanceTest } from './server';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../types';

// The skip decision happens before any network request, so an unreachable
// URL proves the scenario was not run.
const UNREACHABLE_URL = 'http://127.0.0.1:9/mcp';

describe('runServerConformanceTest spec-version applicability', () => {
  test('skips a draft-only scenario at an explicit dated spec version', async () => {
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-stateless',
      undefined,
      LATEST_SPEC_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
  });

  test('skips a removed-in-draft scenario at the draft spec version', async () => {
    // server-initialize tests the stateful handshake, which the draft
    // (stateless) lifecycle removed.
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-initialize',
      undefined,
      DRAFT_PROTOCOL_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
  });

  test('does not skip an applicable scenario/spec-version combination', async () => {
    // server-stateless at draft is applicable; the runner proceeds to run it
    // (against an unreachable server, so checks exist and report failures —
    // the point is only that it was not skipped).
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-stateless',
      undefined,
      DRAFT_PROTOCOL_VERSION
    );
    expect(result.skipped).toBeUndefined();
    expect(result.checks.length).toBeGreaterThan(0);
  }, 60000);
});

describe('runServerConformanceTest per-scenario timeout', () => {
  // A server that completes the TCP handshake and then never writes a byte.
  // Before the runner bounded `scenario.run`, this hung the whole suite: the
  // scenario had no timeout of its own, so nothing downstream ever ran.
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    server = http.createServer(() => {
      // Deliberately never respond, and never destroy the socket.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('fails the scenario instead of hanging when the server never responds', async () => {
    const start = Date.now();
    const result = await runServerConformanceTest(
      url,
      'server-initialize',
      undefined,
      undefined,
      false,
      1000
    );
    const elapsed = Date.now() - start;

    const timeoutCheck = result.checks.find((c) => c.id === 'scenario-timeout');
    expect(timeoutCheck).toBeDefined();
    expect(timeoutCheck?.status).toBe('FAILURE');
    expect(timeoutCheck?.errorMessage).toContain('1000ms');

    // The bound is what makes this a failure rather than a stall; without it
    // the call never returns and this assertion is never reached.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);
});

describe('runServerConformanceTest wire selection for draft-only scenarios', () => {
  // Regression: the CLI used to silently emit the legacy initialize+session
  // wire when running a draft-only scenario, producing requests with no
  // `_meta.io.modelcontextprotocol/*` envelope (and `initialize` rather
  // than `server/discover`). Deriving wire from spec version on the
  // RunContext makes the CLI emit SEP-2575 stateless traffic on draft.
  let server: http.Server;
  let url: string;
  const captured: Array<{ method?: string; params?: Record<string, unknown> }> =
    [];
  // Bodies the mock couldn't parse as JSON. We surface these via an
  // explicit assertion (rather than silently dropping) because in this
  // test's scope, every body MUST be a JSON-RPC request — anything else
  // is the kind of malformed-wire regression this test exists to catch.
  const parseFailures: string[] = [];

  beforeEach(async () => {
    captured.length = 0;
    parseFailures.length = 0;
    server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (chunk) => {
        buf += chunk;
      });
      req.on('end', () => {
        let id: unknown = null;
        try {
          const body = JSON.parse(buf);
          captured.push({ method: body.method, params: body.params });
          id = body.id ?? null;
        } catch {
          parseFailures.push(buf);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'mock server: scenario aborted' }
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('emits SEP-2575 stateless wire (no initialize, _meta envelope) on tasks-lifecycle', async () => {
    await runServerConformanceTest(url, 'tasks-lifecycle');

    // Every outgoing body MUST be JSON-RPC. Hitting this assertion would
    // mean the harness emitted something the mock couldn't parse — a
    // significant regression in its own right, surface it loudly.
    expect(parseFailures).toEqual([]);

    expect(captured.length).toBeGreaterThan(0);

    // The legacy wire opens with an `initialize` handshake; SEP-2575
    // removes it. The scenario MUST NOT have sent one.
    expect(captured.some((c) => c.method === 'initialize')).toBe(false);

    // Every body MUST carry the SEP-2575 `_meta` envelope.
    const first = captured[0];
    const meta = first.params?._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
    expect(meta?.['io.modelcontextprotocol/clientInfo']).toBeDefined();
    expect(meta?.['io.modelcontextprotocol/clientCapabilities']).toBeDefined();

    // Scenario-passed capabilities (not just defaults) must reach the wire.
    const caps = meta?.['io.modelcontextprotocol/clientCapabilities'] as
      | Record<string, unknown>
      | undefined;
    expect(caps?.extensions).toMatchObject({
      'io.modelcontextprotocol/tasks': {}
    });
  }, 30000);
});

describe('runServerConformanceTest session teardown', () => {
  // A minimal stateful Streamable HTTP server that records the methods it is
  // sent, so a test can assert on the DELETE that terminates the session.
  // `promptsList` decides which exit path the prompts-list scenario takes:
  // 'ok' its success path, 'error' its catch, 'hang' the runner's timeout.
  let server: http.Server;
  let url: string;
  let methods: string[];
  let liveSessions: Set<string>;
  let promptsList: 'ok' | 'error' | 'hang';

  const sse = (res: http.ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  };

  beforeEach(async () => {
    methods = [];
    liveSessions = new Set();
    promptsList = 'ok';

    server = http.createServer((req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'DELETE') {
        methods.push('DELETE');
        if (sessionId) liveSessions.delete(sessionId);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET') {
        // The standalone SSE stream: held open, as a real server holds it.
        methods.push('GET');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': open\n\n');
        return;
      }

      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const msg = JSON.parse(raw || '{}');
        methods.push(`POST ${msg.method}`);

        if (msg.method === 'initialize') {
          const sessionId = `s${liveSessions.size + 1}`;
          liveSessions.add(sessionId);
          res.setHeader('mcp-session-id', sessionId);
          sse(res, {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: msg.params.protocolVersion,
              capabilities: { prompts: {} },
              serverInfo: { name: 'teardown-probe', version: '0.0.1' }
            }
          });
          return;
        }
        if (msg.id === undefined) {
          res.writeHead(202).end(); // notification
          return;
        }
        if (msg.method === 'prompts/list' && promptsList === 'hang') {
          return; // accepted, never answered
        }
        if (msg.method === 'prompts/list' && promptsList === 'ok') {
          sse(res, {
            jsonrpc: '2.0',
            id: msg.id,
            result: { prompts: [{ name: 'p', description: 'd' }] }
          });
          return;
        }
        sse(res, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` }
        });
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const deleteCount = () => methods.filter((m) => m === 'DELETE').length;

  test('terminates the session when the scenario fails', async () => {
    // prompts/list answers -32601, so the scenario throws and its own
    // close() — the last statement of its try block — never runs.
    promptsList = 'error';
    const result = await runServerConformanceTest(
      url,
      'prompts-list',
      undefined,
      '2025-06-18'
    );

    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(true);
    expect(deleteCount()).toBe(1);
    expect([...liveSessions]).toEqual([]);
  }, 60000);

  test('terminates the session when the scenario times out', async () => {
    // The timeout path abandons the scenario with its promise left pending, so
    // no `finally` inside the scenario can ever run: only the runner can close.
    promptsList = 'hang';
    const result = await runServerConformanceTest(
      url,
      'prompts-list',
      undefined,
      '2025-06-18',
      false,
      2000
    );

    expect(result.checks.some((c) => c.id === 'scenario-timeout')).toBe(true);
    expect(deleteCount()).toBe(1);
    expect([...liveSessions]).toEqual([]);
  }, 60000);

  test('does not terminate a session twice when the scenario closed it', async () => {
    // A second close() re-sends the DELETE, so cleanup must skip connections
    // the scenario already closed.
    promptsList = 'ok';
    const result = await runServerConformanceTest(
      url,
      'prompts-list',
      undefined,
      '2025-06-18'
    );

    expect(result.checks.every((c) => c.status !== 'FAILURE')).toBe(true);
    expect(deleteCount()).toBe(1);
    expect([...liveSessions]).toEqual([]);
  }, 60000);
});
