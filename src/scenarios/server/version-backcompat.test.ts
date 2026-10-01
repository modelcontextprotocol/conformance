import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MODERN_PROBE_ID,
  probeLegacyHttpFallback,
  RECOGNIZED_MODERN_ERROR_CODES
} from '../../version-compat';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

const SERVER_URL = 'http://localhost:3000/mcp';

describe('legacy HTTP fallback diagnostic', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('classifies a generic HTTP 400 and sends a valid modern probe', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: MODERN_PROBE_ID,
          error: { code: -32600, message: 'Invalid Request' }
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
      kind: 'legacy-fallback',
      status: 400
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(SERVER_URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json, text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('mcp-protocol-version')).toBe(DRAFT_PROTOCOL_VERSION);
    expect(headers.get('mcp-method')).toBe('tools/list');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: '2.0',
      id: MODERN_PROBE_ID,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION
        }
      }
    });
  });

  test.each([...RECOGNIZED_MODERN_ERROR_CODES])(
    'classifies recognized modern error %i as modern',
    async (code) => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: MODERN_PROBE_ID,
            error: { code, message: 'Modern protocol error' }
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
        kind: 'modern',
        status: 400,
        errorCode: code
      });
    }
  );

  test('classifies empty and non-JSON HTTP 400 responses as legacy fallback', async () => {
    for (const body of ['', 'legacy endpoint']) {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
    }

    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toMatchObject({
      kind: 'legacy-fallback'
    });
    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toMatchObject({
      kind: 'legacy-fallback'
    });
  });

  test('does not trust a recognized code in a malformed or mismatched envelope', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'different-request',
          error: { code: -32022, message: 'Wrong response' }
        }),
        { status: 400 }
      )
    );

    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
      kind: 'legacy-fallback',
      status: 400
    });
  });

  test.each([200, 401, 403, 404, 405, 500])(
    'does not classify HTTP %i as initialization-era fallback',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
        kind: 'other',
        status
      });
    }
  );

  test('reports transport failures as unavailable diagnostics', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
      kind: 'unavailable',
      error: 'connection refused'
    });
  });

  test('reports oversized probe responses as unavailable diagnostics', async () => {
    fetchMock.mockResolvedValue(
      new Response('oversized', {
        status: 400,
        headers: { 'Content-Length': String(1024 * 1024 + 1) }
      })
    );
    await expect(probeLegacyHttpFallback(SERVER_URL)).resolves.toEqual({
      kind: 'unavailable',
      error: 'Response body exceeds 1048576 bytes'
    });
  });
});
