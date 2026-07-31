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
