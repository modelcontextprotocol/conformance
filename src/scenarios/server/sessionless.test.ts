import { testContext } from '../../connection/testing';
import { ServerSessionlessScenario } from './sessionless';
import { describe, test, expect, afterEach } from 'vitest';
import { ConformanceCheck, DRAFT_PROTOCOL_VERSION } from '../../types';

const findCheck = (checks: ConformanceCheck[], id: string) =>
  checks.find((c) => c.id === id);

interface MockRequest {
  httpMethod: string;
  rpcMethod?: string;
  rpcId?: string | number | null;
  headers: Record<string, string>;
}

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
}

type MockHandler = (req: MockRequest) => MockResponse | undefined;

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * Install a mocked MCP server behind global.fetch. The handler sees every
 * request (HTTP method, JSON-RPC method, lower-cased headers) and returns a
 * response config; returning undefined falls through to a -32601/404.
 */
function installMockServer(handler: MockHandler): string {
  global.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    const httpMethod = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>
    )) {
      headers[key.toLowerCase()] = String(value);
    }
    let body: { method?: string; id?: string | number | null } | undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        // not JSON
      }
    }
    const config = handler({
      httpMethod,
      rpcMethod: body?.method,
      rpcId: body?.id,
      headers
    }) ?? {
      status: 404,
      json: {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32601, message: 'Method not found' }
      }
    };
    return new Response(
      config.json !== undefined ? JSON.stringify(config.json) : null,
      {
        status: config.status,
        headers: {
          'content-type': 'application/json',
          ...(config.headers ?? {})
        }
      }
    );
  }) as typeof fetch;
  return 'http://mock-sessionless-server.local/mcp';
}

/**
 * A compliant draft-only (2026-only) server: declares all three list
 * capabilities, serves stable lists, 404/-32601s the legacy initialize
 * handshake, 405s GET/DELETE, and never mints session IDs.
 */
function compliantDraftOnlyServer(req: MockRequest): MockResponse | undefined {
  if (req.httpMethod === 'GET' || req.httpMethod === 'DELETE') {
    return { status: 405 };
  }
  const ok = (result: unknown): MockResponse => ({
    status: 200,
    json: { jsonrpc: '2.0', id: req.rpcId, result }
  });
  switch (req.rpcMethod) {
    case 'server/discover':
      return ok({
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'mock-sessionless-server', version: '1.0.0' }
      });
    case 'tools/list':
      return ok({ tools: [{ name: 'alpha' }, { name: 'beta' }] });
    case 'resources/list':
      return ok({ resources: [{ uri: 'file:///stable.txt' }] });
    case 'prompts/list':
      return ok({ prompts: [{ name: 'stable-prompt' }] });
    default:
      return undefined; // initialize and unknown methods: 404 / -32601
  }
}

async function runScenario(mockUrl: string): Promise<ConformanceCheck[]> {
  const scenario = new ServerSessionlessScenario();
  return scenario.run(testContext(mockUrl, DRAFT_PROTOCOL_VERSION));
}

describe('Sessionless Server Scenario', () => {
  test('compliant draft-only server passes every check', async () => {
    const mockUrl = installMockServer(compliantDraftOnlyServer);
    const checks = await runScenario(mockUrl);

    expect(checks.length).toBe(7);
    for (const check of checks) {
      expect(check.status, `${check.id}: ${check.errorMessage}`).toBe(
        'SUCCESS'
      );
    }
  });

  test('flags a server that requires a session header', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.httpMethod === 'POST' && !req.headers['mcp-session-id']) {
        return {
          status: 400,
          json: {
            jsonrpc: '2.0',
            id: req.rpcId ?? null,
            error: {
              code: -32000,
              message: 'Bad Request: Mcp-Session-Id required'
            }
          }
        };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    const check = findCheck(
      checks,
      'sep-2567-server-accepts-requests-without-session-id'
    );
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('Mcp-Session-Id');
  });

  test('flags a draft-only server that mints session IDs', async () => {
    const mockUrl = installMockServer((req) => {
      const response = compliantDraftOnlyServer(req);
      if (req.httpMethod === 'POST' && response?.status === 200) {
        return {
          ...response,
          headers: { 'Mcp-Session-Id': 'minted-session-id' }
        };
      }
      return response;
    });
    const checks = await runScenario(mockUrl);

    const check = findCheck(checks, 'sep-2567-server-ignores-session-id');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('minted');
  });

  test('flags a draft-only server that rejects requests carrying a stale session id', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.httpMethod === 'POST' && req.headers['mcp-session-id']) {
        return {
          status: 404,
          json: {
            jsonrpc: '2.0',
            id: req.rpcId ?? null,
            error: { code: -32001, message: 'Session not found' }
          }
        };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    const check = findCheck(checks, 'sep-2567-server-ignores-session-id');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('not served normally');
  });

  test('flags a draft-only server that serves GET or DELETE', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.httpMethod === 'GET') {
        return { status: 200, json: {} };
      }
      if (req.httpMethod === 'DELETE') {
        return { status: 404 };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    const check = findCheck(checks, 'sep-2567-server-rejects-get-and-delete');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('GET returned 200');
    expect(check?.errorMessage).toContain('DELETE returned 404');
  });

  test('flags a draft-only server that chokes on Last-Event-ID', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.httpMethod === 'POST' && req.headers['last-event-id']) {
        return {
          status: 400,
          json: {
            jsonrpc: '2.0',
            id: req.rpcId ?? null,
            error: { code: -32600, message: 'Cannot resume stream' }
          }
        };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    const check = findCheck(checks, 'sep-2567-server-ignores-last-event-id');
    expect(check?.status).toBe('WARNING');
  });

  test('flags a tools list that varies between connections', async () => {
    let callCount = 0;
    const mockUrl = installMockServer((req) => {
      if (req.rpcMethod === 'tools/list') {
        callCount++;
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id: req.rpcId,
            result: { tools: [{ name: `per-connection-tool-${callCount}` }] }
          }
        };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    const tools = findCheck(checks, 'sep-2567-tools-list-connection-invariant');
    expect(tools?.status).toBe('FAILURE');
    expect(tools?.errorMessage).toContain('diverged');

    // The other list endpoints are stable and must still pass.
    expect(
      findCheck(checks, 'sep-2567-resources-list-connection-invariant')?.status
    ).toBe('SUCCESS');
    expect(
      findCheck(checks, 'sep-2567-prompts-list-connection-invariant')?.status
    ).toBe('SUCCESS');
  });

  test('skips list checks for capabilities the server does not declare', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.rpcMethod === 'server/discover') {
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id: req.rpcId,
            result: {
              supportedVersions: [DRAFT_PROTOCOL_VERSION],
              capabilities: { tools: {} },
              serverInfo: { name: 'tools-only-server', version: '1.0.0' }
            }
          }
        };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    expect(
      findCheck(checks, 'sep-2567-tools-list-connection-invariant')?.status
    ).toBe('SUCCESS');
    expect(
      findCheck(checks, 'sep-2567-resources-list-connection-invariant')?.status
    ).toBe('SKIPPED');
    expect(
      findCheck(checks, 'sep-2567-prompts-list-connection-invariant')?.status
    ).toBe('SKIPPED');
  });

  test('skips backward-compatibility checks for dual-era servers', async () => {
    const mockUrl = installMockServer((req) => {
      if (req.rpcMethod === 'initialize') {
        // Legacy era: serve the initialize handshake and mint a session.
        return {
          status: 200,
          headers: { 'Mcp-Session-Id': 'legacy-session-id' },
          json: {
            jsonrpc: '2.0',
            id: req.rpcId,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'dual-era-server', version: '1.0.0' }
            }
          }
        };
      }
      if (req.httpMethod === 'GET' || req.httpMethod === 'DELETE') {
        // Legacy sessions are served, so these are not 405.
        return { status: 400 };
      }
      return compliantDraftOnlyServer(req);
    });
    const checks = await runScenario(mockUrl);

    expect(
      findCheck(checks, 'sep-2567-server-rejects-get-and-delete')?.status
    ).toBe('SKIPPED');
    expect(
      findCheck(checks, 'sep-2567-server-ignores-session-id')?.status
    ).toBe('SKIPPED');
    expect(
      findCheck(checks, 'sep-2567-server-ignores-last-event-id')?.status
    ).toBe('SKIPPED');

    // The sessionless core invariants still apply to the modern era.
    expect(
      findCheck(checks, 'sep-2567-server-accepts-requests-without-session-id')
        ?.status
    ).toBe('SUCCESS');
    expect(
      findCheck(checks, 'sep-2567-tools-list-connection-invariant')?.status
    ).toBe('SUCCESS');
  });
});
