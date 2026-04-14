/**
 * Unit tests for ServerVersionNegotiationScenario.
 *
 * These tests prove the scenario correctly catches broken-server behaviour
 * (the "evidence it fails when it should" requirement from AGENTS.md) as well
 * as passing on a well-behaved server.
 *
 * fetch() is stubbed globally so no real HTTP server is needed. No session IDs
 * are returned by any mock, which means sessionsToClear stays empty and no
 * DELETE clean-up calls are issued -- keeping mock setup minimal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerVersionNegotiationScenario } from './version-negotiation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Response whose body is a single SSE `data:` event containing
 * `message` encoded as JSON, matching the MCP StreamableHTTP transport format.
 */
function sseResponse(
  message: Record<string, unknown>,
  headers: Record<string, string> = {}
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(message)}\n\n`)
      );
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers }
  });
}

/**
 * Like sseResponse() but the data: payload is deliberately not valid JSON,
 * causing readFirstSSEMessage() to return { __parseError: ... }.
 */
function sseGarbageResponse(headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: this-is-not-json{{{\n\n'));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers }
  });
}

/** Convenience wrapper: build a well-formed InitializeResult envelope. */
function initOk(
  protocolVersion: string,
  id: number = 1
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion,
      capabilities: {},
      serverInfo: { name: 'mock-server', version: '0.0.0' }
    }
  };
}

/** Convenience wrapper: build a JSON-RPC error envelope. */
function rpcError(
  code: number,
  message: string,
  id: number = 1
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerVersionNegotiationScenario', () => {
  const serverUrl = 'http://localhost:3000/mcp';
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns SUCCESS for all three checks on a well-behaved server', async () => {
    fetchMock
      // Check 1: server echoes the requested 2025-11-25
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      // Check 2: server negotiates 2025-11-25 in response to 1999-01-01
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      // Check 3: ping succeeds with header present
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ id: 'version-echo', status: 'SUCCESS' });
    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'SUCCESS'
    });
    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'SUCCESS'
    });
    // Verify the scenario sent exactly 3 requests (no extra session or cleanup calls).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // version-echo failures
  // -------------------------------------------------------------------------

  it('reports version-echo FAILURE when server echoes the wrong version', async () => {
    // Server returns 2025-06-18 even though the client asked for 2025-11-25.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-06-18', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[0]).toMatchObject({ id: 'version-echo', status: 'FAILURE' });
    expect(checks[0].errorMessage).toContain('2025-06-18');
    expect(checks[0].errorMessage).toContain('2025-11-25');
    // version-negotiate and http-protocol-version-header should still run independently.
    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'SUCCESS'
    });
    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'SUCCESS'
    });
  });

  it('reports version-echo FAILURE when server returns a JSON-RPC error on initialize', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(rpcError(-32603, 'internal error', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[0]).toMatchObject({ id: 'version-echo', status: 'FAILURE' });
    expect(checks[0].errorMessage).toContain('JSON-RPC error');
    expect(checks[0].errorMessage).toContain('-32603');
  });

  it('reports version-echo FAILURE when InitializeResult is missing protocolVersion', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            capabilities: {},
            serverInfo: { name: 'mock', version: '0.0.0' }
          }
        })
      )
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[0]).toMatchObject({ id: 'version-echo', status: 'FAILURE' });
    expect(checks[0].errorMessage).toContain('missing');
    expect(checks[0].errorMessage).toContain('protocolVersion');
  });

  // -------------------------------------------------------------------------
  // version-negotiate failures and edge cases
  // -------------------------------------------------------------------------

  it('reports version-negotiate FAILURE when server returns a JSON-RPC error instead of negotiating', async () => {
    // Most common server bug: rejecting an unknown version with an error rather
    // than negotiating down to a supported one.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(
        sseResponse(rpcError(-32602, 'unsupported protocol version', 2))
      )
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'FAILURE'
    });
    expect(checks[1].errorMessage).toContain('JSON-RPC error');
    expect(checks[1].errorMessage).toContain('negotiating');
  });

  it('reports version-negotiate FAILURE when server echoes back 1999-01-01 (year < MIN_SPEC_YEAR)', async () => {
    // Server bug: it echoes whatever the client sent instead of substituting a
    // version it actually supports.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('1999-01-01', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'FAILURE'
    });
    expect(checks[1].errorMessage).toContain('1999-01-01');
    expect(checks[1].errorMessage).toContain('not a valid spec version');
  });

  it('reports version-negotiate WARNING when server returns an unrecognized future version (2026-03-15)', async () => {
    // Valid date format and year >= 2025, but not in KNOWN_SPEC_VERSIONS.
    // The harness cannot verify this is a real spec release, so it warns rather
    // than blocking (the server may simply be running a newer spec than the harness knows about).
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2026-03-15', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'WARNING',
      details: expect.objectContaining({
        receivedVersion: '2026-03-15'
      }) as unknown
    });
    expect(checks[1].errorMessage).toContain('2026-03-15');
    expect(checks[1].errorMessage).toContain('known spec');
  });

  // -------------------------------------------------------------------------
  // Regression: check 3 must use the negotiated version, not a hardcoded constant
  // -------------------------------------------------------------------------

  it('sends the negotiated version from check 1 as MCP-Protocol-Version header in check 3', async () => {
    // Check 1 returns 2025-06-18 (version-echo FAILURE), but check 3 must still
    // use 2025-06-18 -- not fall back to the hardcoded CURRENT_PROTOCOL_VERSION.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-06-18', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse({ jsonrpc: '2.0', id: 2, result: {} })
      );

    await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, pingOptions] = fetchMock.mock.calls[2] as [string, RequestInit];
    const headers = pingOptions.headers as Record<string, string>;
    // Must be the server-returned version, not the constant 2025-11-25.
    expect(headers['MCP-Protocol-Version']).toBe('2025-06-18');
  });

  // -------------------------------------------------------------------------
  // http-protocol-version-header outcomes
  // -------------------------------------------------------------------------

  it('reports http-protocol-version-header FAILURE when server returns HTTP 4xx', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      // Server rejects the ping -- possibly because it doesn't recognise the header.
      .mockResolvedValueOnce(
        new Response('Bad Request', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        })
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'FAILURE'
    });
    expect(checks[2].errorMessage).toContain('HTTP 400');
    expect(checks[2].details).toMatchObject({ httpStatus: 400 });
  });

  it('reports http-protocol-version-header SKIPPED when check 1 threw a transport error', async () => {
    // Check 1: connection refused -- server is not reachable.
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'))
      // Check 2: server came back up (independently verifiable).
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)));
    // No third mock: check 3 must NOT issue a fetch call.

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ id: 'version-echo', status: 'FAILURE' });
    expect(checks[0].errorMessage).toContain('transport error');
    expect(checks[1]).toMatchObject({
      id: 'version-negotiate',
      status: 'SUCCESS'
    });
    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'SKIPPED'
    });
    // Verify check 3 did not invoke fetch (only 2 calls total).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports http-protocol-version-header SUCCESS when ping returns -32601 (method not found)', async () => {
    // ping is optional in MCP. -32601 means the server processed the envelope
    // and accepted the MCP-Protocol-Version header -- it just doesn't implement ping.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse(rpcError(-32601, 'Method not found', 2))
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'SUCCESS'
    });
    expect(checks[2].details).toMatchObject({
      note: expect.stringContaining('-32601') as unknown
    });
  });

  it('reports http-protocol-version-header WARNING when ping returns an unexpected JSON-RPC error', async () => {
    // Some other error code -- we cannot tell if the header caused it.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(
        sseResponse(rpcError(-32603, 'internal server error', 2))
      );

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'WARNING'
    });
    expect(checks[2].errorMessage).toContain('cannot determine');
  });

  it('reports http-protocol-version-header WARNING when 2xx response body is unparseable', async () => {
    // Server returned 200 but the SSE payload is garbage -- unusual but should
    // not be silently treated as SUCCESS.
    fetchMock
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 1)))
      .mockResolvedValueOnce(sseResponse(initOk('2025-11-25', 2)))
      .mockResolvedValueOnce(sseGarbageResponse());

    const checks = await new ServerVersionNegotiationScenario().run(serverUrl);

    expect(checks[2]).toMatchObject({
      id: 'http-protocol-version-header',
      status: 'WARNING'
    });
    expect(checks[2].errorMessage).toContain('could not be parsed');
    expect(checks[2].details).toMatchObject({ httpStatus: 200 });
  });
});
