import { describe, test, expect, afterEach } from 'vitest';
import { testContext } from '../../connection/testing';
import {
  HttpHeaderValidationScenario,
  HttpCustomHeaderServerValidationScenario,
  CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS
} from './http-standard-headers';
import type { ConformanceCheck } from '../../types';

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
  handler: (reqBody: any, reqHeaders: Record<string, string>) => any
) {
  global.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const headers = init.headers || {};
    const responseConfig = (await handler(body, headers)) ?? {
      status: 404,
      body: {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Not found' }
      }
    };
    const text = JSON.stringify(responseConfig.body);
    return {
      status: responseConfig.status ?? 200,
      headers: { get: () => 'application/json' },
      json: async () => responseConfig.body,
      text: async () => text
    } as unknown as Response;
  }) as typeof fetch;
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
              tools: [
                {
                  name: 'plain_tool',
                  inputSchema: {
                    type: 'object',
                    properties: { q: { type: 'string' } }
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
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
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
          body: { jsonrpc: '2.0', id: body.id, result: { tools: [] } }
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
