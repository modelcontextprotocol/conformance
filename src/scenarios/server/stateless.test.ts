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

      let responseConfig = await handler(body, headers);

      // GLOBAL SPEC-COMPLIANT FALLBACKS: Provides successful data loops for downstream checks
      // if individual tests are focusing exclusively on separate fields (like discovery or meta checks).
      if (!responseConfig) {
        if (body.method === 'subscriptions/listen') {
          responseConfig = {
            isStream: true,
            status: 200,
            frames: [
              {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: {
                  _meta: {
                    'io.modelcontextprotocol/subscriptionId':
                      'global-valid-sub-id'
                  }
                }
              }
            ]
          };
        } else if (body.method === 'tools/call') {
          responseConfig = {
            isStream: true,
            status: 200,
            frames: [
              {
                jsonrpc: '2.0',
                result: {
                  content: [{ type: 'text', text: 'Progress chunk details' }]
                }
              }
            ]
          };
        }
      }

      if (responseConfig?.isStream) {
        const streamData = responseConfig.frames.map(
          (f: any) => JSON.stringify(f) + '\n'
        );
        let frameIndex = 0;

        const mockReader = {
          read: async () => {
            if (frameIndex >= streamData.length) {
              return { value: undefined, done: true };
            }
            const chunk = new TextEncoder().encode(streamData[frameIndex++]);
            return { value: chunk, done: false };
          }
        };

        return {
          status: responseConfig?.status ?? 200,
          body: {
            getReader: () => mockReader,
            releaseLock: () => {}
          }
        } as unknown as Response;
      }

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

  test('Fails validation when stream does not send subscription acknowledgement or tracking ID', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'subscriptions/listen') {
        return {
          isStream: true,
          status: 200,
          frames: [
            {
              jsonrpc: '2.0',
              method: 'notifications/some-unrelated-event',
              params: { _meta: {} }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const ackCheck = findCheck(
      checks,
      'sep-2575-server-sends-subscription-ack'
    );
    const idCheck = findCheck(checks, 'sep-2575-server-tags-subscription-id');

    expect(ackCheck?.status).toBe('FAILURE');
    expect(idCheck?.status).toBe('FAILURE');
  });

  test('Fails validation when tool response stream leaks raw independent JSON-RPC requests', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (
        reqBody.method === 'tools/call' &&
        reqBody.params?.name === 'test_streaming_elicitation'
      ) {
        return {
          isStream: true,
          status: 200,
          frames: [
            {
              jsonrpc: '2.0',
              id: 'server-driven-id-999',
              method: 'client/some-arbitrary-request',
              params: {}
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const independentRequestCheck = findCheck(
      checks,
      'sep-2575-http-server-no-independent-requests-on-stream'
    );
    expect(independentRequestCheck?.status).toBe('FAILURE');
  });

  test('Fails validation when logging occurs without an explicit client request logLevel metadata', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (
        reqBody.method === 'tools/call' &&
        reqBody.params?.name === 'test_logging_tool'
      ) {
        return {
          isStream: true,
          status: 200,
          frames: [
            {
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: { level: 'debug', text: 'Stray log frame' }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const logWithoutLevelCheck = findCheck(
      checks,
      'sep-2575-server-no-log-without-loglevel'
    );
    expect(logWithoutLevelCheck?.status).toBe('FAILURE');
  });

  test('Fails validation when server leaks out-of-filter notifications on a subscription stream', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      // The scenario subscribes ONLY to prompts list-changed notifications
      if (
        reqBody.method === 'subscriptions/listen' &&
        reqBody.params?.notifications?.promptsListChanged === true
      ) {
        return {
          isStream: true,
          status: 200,
          frames: [
            {
              jsonrpc: '2.0',
              method: 'notifications/subscriptions/acknowledged',
              _meta: {
                'io.modelcontextprotocol/subscriptionId': 'sub-leak-test'
              }
            },
            // LEAK VIOLATION: Server sends tools/list_changed on a prompt-only stream
            {
              jsonrpc: '2.0',
              method: 'notifications/tools/list_changed',
              _meta: {
                'io.modelcontextprotocol/subscriptionId': 'sub-leak-test'
              }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const filterCheck = findCheck(
      checks,
      'sep-2575-server-honors-notification-filter'
    );
    expect(filterCheck?.status).toBe('FAILURE');
  });

  test('Warns when server drops tools or prompts list changed notifications despite declaring capabilities', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      // 1. Declare BOTH capabilities so neither check is skipped
      if (reqBody.method === 'server/discover') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: {
              supportedVersions: ['DRAFT-2026-v1'],
              capabilities: {
                tools: { listChanged: true },
                prompts: { listChanged: true }
              },
              serverInfo: { name: 'test-server', version: '1.0' }
            }
          }
        };
      }

      // 2. Allow BOTH mutation triggers to succeed
      if (
        reqBody.method === 'tools/call' &&
        (reqBody.params?.name === 'test_trigger_prompt_change' ||
          reqBody.params?.name === 'test_trigger_tool_change')
      ) {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: { content: [{ type: 'text', text: 'mutated' }] }
          }
        };
      }

      // 3. Provide the streams but withhold the required notifications for BOTH channels
      if (reqBody.method === 'subscriptions/listen') {
        const filter = reqBody.params?.notifications;
        if (
          filter?.promptsListChanged === true ||
          filter?.toolsListChanged === true
        ) {
          return {
            isStream: true,
            status: 200,
            frames: [
              {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                _meta: {
                  'io.modelcontextprotocol/subscriptionId': 'sub-drop-test'
                }
              }
              // MISSING VIOLATION: We never send the expected notifications/*/list_changed
            ]
          };
        }
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(mockUrl);

    const promptsCheck = findCheck(
      checks,
      'sep-2575-server-sends-prompts-list-changed-on-subscription'
    );
    const toolsCheck = findCheck(
      checks,
      'sep-2575-server-sends-tools-list-changed-on-subscription'
    );

    // These map to SHOULD requirements, so severity is WARNING not FAILURE.
    expect(promptsCheck?.status).toBe('WARNING');
    expect(toolsCheck?.status).toBe('WARNING');
  });
});
