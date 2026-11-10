import http from 'http';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import {
  MODERN_PROBE_ID,
  RECOGNIZED_MODERN_ERROR_CODES
} from '../../version-compat';

const SCENARIO = 'version-backcompat';

interface TestServer {
  url: string;
  counts: { modernProbes: number; initializes: number };
  close(): Promise<void>;
}

interface ModernResponse {
  status: number;
  body?: unknown;
  contentType?: string;
  rejectLegacyRequests?: boolean;
}

async function startTestServer(
  modernResponse: ModernResponse
): Promise<TestServer> {
  const counts = { modernProbes: 0, initializes: 0 };
  const server = http.createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => (rawBody += chunk.toString()));
    request.on('end', () => {
      if (rawBody.length === 0) {
        response.writeHead(200).end();
        return;
      }
      const body = JSON.parse(rawBody);
      const isModernProbe =
        body.method === 'tools/list' &&
        request.headers['mcp-protocol-version'] === '2026-07-28';
      if (isModernProbe) {
        counts.modernProbes += 1;
        const headers = modernResponse.contentType
          ? { 'Content-Type': modernResponse.contentType }
          : undefined;
        response.writeHead(modernResponse.status, headers);
        let responseBody: string | undefined;
        if (typeof modernResponse.body === 'string') {
          responseBody = modernResponse.body;
        } else if (modernResponse.body !== undefined) {
          responseBody = JSON.stringify(modernResponse.body);
        }
        response.end(responseBody);
        return;
      }
      if (body.method === 'initialize') {
        counts.initializes += 1;
        if (modernResponse.rejectLegacyRequests) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32022, message: 'Modern-only endpoint' }
            })
          );
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-test-server', version: '1.0.0' }
            }
          })
        );
        return;
      }
      if (body.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'tools/list' ? { tools: [] } : {}
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine compatibility fixture port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    counts,
    async close(): Promise<void> {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function modernError(
  code: number,
  id: string = MODERN_PROBE_ID
): ModernResponse {
  return {
    status: 400,
    contentType: 'application/json',
    body: {
      jsonrpc: '2.0',
      id,
      error: { code, message: 'Modern protocol error' }
    }
  };
}

describe('version backward-compatibility HTTP classification', () => {
  test.each([...RECOGNIZED_MODERN_ERROR_CODES])(
    'recognized modern error %i does not trigger initialize fallback',
    async (code) => {
      const fixture = await startTestServer(modernError(code));
      try {
        const handler = getHandler(SCENARIO)!;
        await expect(handler(fixture.url)).rejects.toThrow(
          `recognized modern error code ${code}`
        );
        expect(fixture.counts).toEqual({ modernProbes: 1, initializes: 0 });
      } finally {
        await fixture.close();
      }
    }
  );

  test.each([401, 403, 404, 405, 500])(
    'HTTP %i does not trigger initialize fallback',
    async (status) => {
      const fixture = await startTestServer({ status });
      try {
        const handler = getHandler(SCENARIO)!;
        await expect(handler(fixture.url)).rejects.toThrow(
          `Expected legacy endpoint to reject the modern probe with HTTP 400, got ${status}`
        );
        expect(fixture.counts).toEqual({ modernProbes: 1, initializes: 0 });
      } finally {
        await fixture.close();
      }
    }
  );

  test('empty and non-JSON HTTP 400 responses trigger legacy fallback', async () => {
    for (const body of [undefined, 'legacy endpoint']) {
      const fixture = await startTestServer({ status: 400, body });
      try {
        await expect(
          getHandler(SCENARIO)!(fixture.url)
        ).resolves.toBeUndefined();
        expect(fixture.counts).toEqual({ modernProbes: 1, initializes: 1 });
      } finally {
        await fixture.close();
      }
    }
  });

  test('a recognized code with the wrong response id is treated as legacy', async () => {
    const fixture = await startTestServer(
      modernError(-32022, 'different-request')
    );
    try {
      await expect(getHandler(SCENARIO)!(fixture.url)).resolves.toBeUndefined();
      expect(fixture.counts).toEqual({ modernProbes: 1, initializes: 1 });
    } finally {
      await fixture.close();
    }
  });

  test('caches the legacy-era decision for subsequent calls to the same origin', async () => {
    const fixture = await startTestServer({ status: 400 });
    try {
      const handler = getHandler(SCENARIO)!;
      await handler(fixture.url);
      await handler(fixture.url);
      expect(fixture.counts).toEqual({ modernProbes: 1, initializes: 2 });
    } finally {
      await fixture.close();
    }
  });

  test('re-probes when a cached legacy-era decision later fails', async () => {
    const response: ModernResponse = { status: 400 };
    const fixture = await startTestServer(response);
    try {
      const handler = getHandler(SCENARIO)!;
      await handler(fixture.url);

      Object.assign(response, modernError(-32022), {
        rejectLegacyRequests: true
      });
      await expect(handler(fixture.url)).rejects.toThrow(
        'recognized modern error code -32022'
      );
      expect(fixture.counts).toEqual({ modernProbes: 2, initializes: 2 });
    } finally {
      await fixture.close();
    }
  });
});
