import { ServerStatelessScenario } from './stateless';
import { describe, test, expect } from 'vitest';
import { ConformanceCheck } from '../../types';

const findCheck = (checks: ConformanceCheck[], id: string) =>
  checks.find((c) => c.id === id);

describe('Stateless Server Scenario Negative Tests', () => {
  // Inline network mocking helper
  function mockFetchTarget(
    handler: (reqBody: any, reqHeaders: Record<string, string>) => any
  ) {
    global.fetch = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const headers = init.headers || {};
      const responseConfig = await handler(body, headers);

      return {
        status: responseConfig?.status ?? 404,
        json: async () =>
          responseConfig?.body ?? {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Not found' }
          }
      } as Response;
    };
    return 'http://mock-stateless-mcp-server.local';
  }

  test('Fails validation if missing required fields in _meta are allowed to pass', async () => {
    // This bad server completely ignores missing params/_meta fields and returns a fake success result
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'server/discover') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: {
              supportedVersions: ['DRAFT-2026-v1'],
              capabilities: {},
              serverInfo: { name: 'bad-meta-server', version: '1.0.0' }
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    // The test scenario should flag this server as a FAILURE for skipping meta validation
    const missingMetaCheck = findCheck(
      checks,
      'sep-2575-request-meta-invalid-missing-meta'
    );
    const missingVersionCheck = findCheck(
      checks,
      'sep-2575-request-meta-invalid-missing-protocol-version'
    );

    expect(missingMetaCheck?.status).toBe('FAILURE');
    expect(missingVersionCheck?.status).toBe('FAILURE');
  });

  test('Fails validation if removed legacy RPCs do not return HTTP 404 Not Found', async () => {
    // This bad server intercepts the removed 'ping' or 'initialize' methods but incorrectly returns HTTP 200
    const mockUrl = mockFetchTarget((reqBody) => {
      if (
        [
          'initialize',
          'ping',
          'logging/setLevel',
          'resources/subscribe',
          'resources/unsubscribe'
        ].includes(reqBody.method)
      ) {
        return {
          status: 200, // Spec Violation: Must be HTTP 404
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            error: {
              code: -32601,
              message: 'Method removed but returning HTTP 200'
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const pingRouteCheck = findCheck(
      checks,
      'sep-2575-http-server-method-not-found-404-ping'
    );
    const initializeRouteCheck = findCheck(
      checks,
      'sep-2575-http-server-method-not-found-404-initialize'
    );

    expect(pingRouteCheck?.status).toBe('FAILURE');
    expect(initializeRouteCheck?.status).toBe('FAILURE');
  });

  test('Fails validation when version negotiation returns mismatched supported versions data', async () => {
    // This bad server returns an unexpected array of supported versions during negotiation
    const mockUrl = mockFetchTarget((reqBody) => {
      const meta = reqBody.params?._meta;
      if (meta?.['io.modelcontextprotocol/protocolVersion'] === 'v999.0.0') {
        return {
          status: 400,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            error: {
              code: -32602,
              message: 'Unsupported version',
              data: { supported: ['UNEXPECTED-VERSION-STRING-DRIFT'] } // Spec Violation: Mismatches actual versions
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const negotiationMatchCheck = findCheck(
      checks,
      'sep-2575-server-unsupported-version-error'
    );
    expect(negotiationMatchCheck?.status).toBe('FAILURE');
  });
});
