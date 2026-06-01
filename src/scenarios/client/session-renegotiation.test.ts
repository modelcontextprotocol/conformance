import { describe, test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { SessionRenegotiation404Scenario } from './session-renegotiation';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { getScenario } from '../index';

/**
 * Streamable HTTP: when a client receives HTTP 404 for a request carrying an
 * MCP-Session-Id, it MUST start a new session with a fresh InitializeRequest
 * (no session ID) and continue operating. See issue #76.
 *
 * Positive: the everything-client renegotiates and resumes operating.
 * Negative: a client that treats the 404 as fatal (never re-initializes) must
 * fail client-session-renegotiate-on-404.
 */

const SCENARIO = 'session-renegotiation-404';

describe('session-renegotiation-404 client scenario', () => {
  test('scenario is registered', () => {
    expect(getScenario(SCENARIO)).toBeDefined();
  });

  test('everything-client renegotiates on 404 and keeps operating', async () => {
    const clientFn = getHandler(SCENARIO);
    if (!clientFn) {
      throw new Error(`No handler registered for scenario: ${SCENARIO}`);
    }

    const scenario = getScenario(SCENARIO);
    if (!scenario) {
      throw new Error(`Scenario not found: ${SCENARIO}`);
    }

    await runClientAgainstScenario(new InlineClientRunner(clientFn), SCENARIO);

    const checks = scenario.getChecks();
    for (const check of checks) {
      expect(
        check.status,
        `Check "${check.id}" failed: ${check.errorMessage ?? ''}`
      ).toBe('SUCCESS');
    }

    expect(
      checks.find((c) => c.id === 'client-session-renegotiate-on-404')?.status
    ).toBe('SUCCESS');
    expect(
      checks.find(
        (c) => c.id === 'client-session-continues-after-renegotiation'
      )?.status
    ).toBe('SUCCESS');
  });

  // A client that initializes, makes one request, gets the 404, and gives up
  // without re-initializing. This is the "bricked trajectory" behavior the
  // requirement forbids.
  async function nonRenegotiatingClient(serverUrl: string): Promise<void> {
    const client = new Client(
      { name: 'no-reconnect-client', version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client.connect(transport);
    // Triggers the 404; the SDK transport throws and we deliberately do not
    // renegotiate — surfacing the failure the scenario must catch.
    await client.listTools();
    await transport.close();
  }

  test('client that does not renegotiate fails the 404 renegotiation check', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(nonRenegotiatingClient),
      SCENARIO,
      { expectedFailureSlugs: ['client-session-renegotiate-on-404'] }
    );
  });

  test('emits a FAILURE when the client never makes a session-bearing request', async () => {
    const scenario = new SessionRenegotiation404Scenario();
    await scenario.start();
    try {
      const checks = scenario.getChecks();
      const renegotiate = checks.find(
        (c) => c.id === 'client-session-renegotiate-on-404'
      );
      expect(renegotiate?.status).toBe('FAILURE');
      const continues = checks.find(
        (c) => c.id === 'client-session-continues-after-renegotiation'
      );
      expect(continues?.status).toBe('SKIPPED');
    } finally {
      await scenario.stop();
    }
  });
});
