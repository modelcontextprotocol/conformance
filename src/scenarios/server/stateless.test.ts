import { testContext } from '../../connection/testing';
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
          },
          // Required by listenToStream's finally block; without it the
          // reader teardown throws, the stream helper swallows the error,
          // and every stream-based assertion silently runs against zero
          // frames — the exact vacuous-pass failure mode this suite exists
          // to prevent.
          releaseLock: () => {}
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

  // Shared server/discover stanza for the negative-server mocks below.
  const discoverResponse = (
    reqBody: any,
    capabilities: object,
    serverName: string
  ) => ({
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: reqBody.id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities,
        serverInfo: { name: serverName, version: '1.0.0' }
      }
    }
  });

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
              supportedVersions: ['2026-07-28'],
              capabilities: {},
              serverInfo: { name: 'bad-meta-server', version: '1.0.0' }
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

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

  test('Fails (untestable) the capability checks when the diagnostic tool is not listed', async () => {
    // This server has no test_missing_capability tool at all: the
    // undeclared-capability MUSTs cannot be exercised and must read red,
    // not SKIPPED (issue #248).
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'server/discover') {
        return discoverResponse(reqBody, { tools: {} }, 'no-diagnostic-tools');
      }
      if (reqBody.method === 'tools/list') {
        return {
          status: 200,
          body: { jsonrpc: '2.0', id: reqBody.id, result: { tools: [] } }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const rejectCheck = findCheck(
      checks,
      'sep-2575-server-rejects-undeclared-capability'
    );
    const statusCheck = findCheck(
      checks,
      'sep-2575-missing-capability-http-400'
    );

    expect(rejectCheck?.status).toBe('FAILURE');
    expect(rejectCheck?.errorMessage).toContain('Not testable:');
    expect(rejectCheck?.errorMessage).toContain('test_missing_capability');
    expect(statusCheck?.status).toBe('FAILURE');
    expect(statusCheck?.errorMessage).toContain('Not testable:');
  });

  // A server that lists test_missing_capability and answers its probe call
  // with the given response; shared by the capability-shape tests below so
  // the fixture contract lives in one place.
  function capabilityProbeMock(
    label: string,
    callResponse: { status: number; body: object }
  ) {
    return mockFetchTarget((reqBody) => {
      if (reqBody.method === 'server/discover') {
        return discoverResponse(reqBody, { tools: {} }, label);
      }
      if (reqBody.method === 'tools/list') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: { tools: [{ name: 'test_missing_capability' }] }
          }
        };
      }
      if (
        reqBody.method === 'tools/call' &&
        reqBody.params?.name === 'test_missing_capability'
      ) {
        return {
          status: callResponse.status,
          body: { jsonrpc: '2.0', id: reqBody.id, ...callResponse.body }
        };
      }
    });
  }

  const spec32021 = (requiredCapabilities: unknown) => ({
    error: {
      code: -32021,
      message: 'MissingRequiredClientCapabilityError',
      data: { requiredCapabilities }
    }
  });

  test('Fails the capability check when the listed diagnostic tool executes without -32021', async () => {
    // This server lists test_missing_capability but happily executes it even
    // though the client never declared the sampling capability — a genuine
    // violation of the MUST, not an untestable gap.
    const mockUrl = capabilityProbeMock('no-enforcement', {
      status: 200,
      body: { result: { resultType: 'complete', content: [] } }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const rejectCheck = findCheck(
      checks,
      'sep-2575-server-rejects-undeclared-capability'
    );
    expect(rejectCheck?.status).toBe('FAILURE');
    expect(rejectCheck?.errorMessage).toContain('MUST reject with -32021');
  });

  test('Passes the capability checks on a spec-shaped -32021: requiredCapabilities is a ClientCapabilities object', async () => {
    // The schema's MissingRequiredClientCapabilityError carries
    // `data.requiredCapabilities` as a ClientCapabilities OBJECT keyed by the
    // missing capability (e.g. `{ "sampling": {} }`), not an array of names.
    const mockUrl = capabilityProbeMock('spec-shaped-32021', {
      status: 400,
      body: spec32021({ sampling: {} })
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    expect(
      findCheck(checks, 'sep-2575-server-rejects-undeclared-capability')?.status
    ).toBe('SUCCESS');
    expect(
      findCheck(checks, 'sep-2575-missing-capability-http-400')?.status
    ).toBe('SUCCESS');
  });

  test('Fails the capability check when requiredCapabilities is an array of names instead of the schema object', async () => {
    const mockUrl = capabilityProbeMock('array-shaped-32021', {
      status: 400,
      body: spec32021(['sampling'])
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const rejectCheck = findCheck(
      checks,
      'sep-2575-server-rejects-undeclared-capability'
    );
    expect(rejectCheck?.status).toBe('FAILURE');
    expect(rejectCheck?.errorMessage).toContain('ClientCapabilities object');
  });

  test('Fails the capability check when the sampling capability value is not an object (e.g. null)', async () => {
    // ClientCapabilities values are themselves objects; `{ sampling: null }`
    // is schema-invalid and must not be certified.
    const mockUrl = capabilityProbeMock('null-valued-32021', {
      status: 400,
      body: spec32021({ sampling: null })
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const rejectCheck = findCheck(
      checks,
      'sep-2575-server-rejects-undeclared-capability'
    );
    expect(rejectCheck?.status).toBe('FAILURE');
    expect(rejectCheck?.errorMessage).toContain('ClientCapabilities object');
  });

  test('Fails the subscription checks when listChanged is advertised but listen is rejected', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'server/discover') {
        return discoverResponse(
          reqBody,
          { tools: { listChanged: true } },
          'claims-subscriptions'
        );
      }
      if (reqBody.method === 'subscriptions/listen') {
        return {
          isStream: true,
          status: 404,
          frames: [
            {
              jsonrpc: '2.0',
              id: reqBody.id,
              error: { code: -32601, message: 'Method not found' }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const ackCheck = findCheck(
      checks,
      'sep-2575-server-sends-subscription-ack'
    );
    expect(ackCheck?.status).toBe('FAILURE');
    expect(ackCheck?.errorMessage).toContain('Not testable:');
    expect(ackCheck?.errorMessage).toContain('-32601');
  });

  test('Skips the subscription checks when no subscription capability is advertised', async () => {
    // A server that never claimed listChanged/subscribe legitimately has
    // nothing to serve on subscriptions/listen — this is the one case that
    // stays SKIPPED.
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'server/discover') {
        return discoverResponse(reqBody, { tools: {} }, 'no-subscriptions');
      }
      if (reqBody.method === 'subscriptions/listen') {
        return {
          isStream: true,
          status: 404,
          frames: [
            {
              jsonrpc: '2.0',
              id: reqBody.id,
              error: { code: -32601, message: 'Method not found' }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const ackCheck = findCheck(
      checks,
      'sep-2575-server-sends-subscription-ack'
    );
    const tagCheck = findCheck(checks, 'sep-2575-server-tags-subscription-id');
    expect(ackCheck?.status).toBe('SKIPPED');
    expect(tagCheck?.status).toBe('SKIPPED');
  });

  test('Fails (untestable) the subscription checks when discover was never observed', async () => {
    // With no server/discover response at all, a -32601 on listen cannot be
    // attributed to an intentionally absent capability — the legitimate skip
    // requires an observed advertisement.
    const mockUrl = mockFetchTarget((reqBody) => {
      if (reqBody.method === 'subscriptions/listen') {
        return {
          isStream: true,
          status: 404,
          frames: [
            {
              jsonrpc: '2.0',
              id: reqBody.id,
              error: { code: -32601, message: 'Method not found' }
            }
          ]
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const ackCheck = findCheck(
      checks,
      'sep-2575-server-sends-subscription-ack'
    );
    expect(ackCheck?.status).toBe('FAILURE');
    expect(ackCheck?.errorMessage).toContain('Not testable:');
    expect(ackCheck?.errorMessage).toContain(
      'server/discover was not observed'
    );
  });

  test('Fails validation when missing-_meta rejections are returned with HTTP 200', async () => {
    // This bad server picks the right JSON-RPC error code but the wrong HTTP
    // status: the spec requires 400 Bad Request for malformed requests.
    const mockUrl = mockFetchTarget((reqBody) => {
      const meta = reqBody.params?._meta;
      const missingRequired =
        !meta ||
        !meta['io.modelcontextprotocol/protocolVersion'] ||
        !meta['io.modelcontextprotocol/clientInfo'] ||
        !meta['io.modelcontextprotocol/clientCapabilities'];
      if (missingRequired) {
        return {
          status: 200, // Spec Violation: must be HTTP 400
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            error: {
              code: -32602,
              message: 'Invalid params: missing _meta or required fields'
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    // The JSON-RPC code is correct, so the per-field checks pass; the wrong
    // HTTP status is caught by the companion status check.
    const missingMetaCheck = findCheck(
      checks,
      'sep-2575-request-meta-invalid-missing-meta'
    );
    const httpStatusCheck = findCheck(
      checks,
      'sep-2575-http-server-meta-invalid-400'
    );

    expect(missingMetaCheck?.status).toBe('SUCCESS');
    expect(httpStatusCheck?.status).toBe('FAILURE');
  });

  test('Fails validation when the unsupported-version error omits data.requested', async () => {
    const mockUrl = mockFetchTarget((reqBody) => {
      const meta = reqBody.params?._meta;
      if (meta?.['io.modelcontextprotocol/protocolVersion'] === 'v999.0.0') {
        return {
          status: 400,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            error: {
              code: -32022,
              message: 'Unsupported protocol version',
              // Spec Violation: data.requested is a required member
              data: { supported: ['2026-07-28'] }
            }
          }
        };
      }
      if (reqBody.method === 'server/discover') {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: reqBody.id,
            result: {
              supportedVersions: ['2026-07-28'],
              capabilities: {},
              serverInfo: { name: 'no-requested-server', version: '1.0.0' }
            }
          }
        };
      }
    });

    const scenario = new ServerStatelessScenario();
    const checks = await scenario.run(testContext(mockUrl));

    const negotiationCheck = findCheck(
      checks,
      'sep-2575-server-unsupported-version-error'
    );
    expect(negotiationCheck?.status).toBe('FAILURE');
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
    const checks = await scenario.run(testContext(mockUrl));

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
    const checks = await scenario.run(testContext(mockUrl));

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
    const checks = await scenario.run(testContext(mockUrl));

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
    const checks = await scenario.run(testContext(mockUrl));

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
    const checks = await scenario.run(testContext(mockUrl));

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
    const checks = await scenario.run(testContext(mockUrl));

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
              supportedVersions: ['2026-07-28'],
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
    const checks = await scenario.run(testContext(mockUrl));

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
