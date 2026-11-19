/**
 * Capability gating for `elicitation-sep1034-client-defaults` (issue #584).
 *
 * Elicitation is an optional client capability at 2025-11-25. A client that
 * negotiates without it must not be sent `elicitation/create`; its checks
 * are SKIPPED, not failed. A client that does declare it is still scored.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConformanceCheck, Scenario } from '../../types';
import { testScenarioContext } from '../../mock-server/testing';
import { getScenario } from '../index';

const SCENARIO_NAME = 'elicitation-sep1034-client-defaults';
const ELICITATION_CHECK_PREFIX = 'client-elicitation-sep1034-';

const DEFAULT_SLUGS = [
  'client-elicitation-sep1034-string-default',
  'client-elicitation-sep1034-integer-default',
  'client-elicitation-sep1034-number-default',
  'client-elicitation-sep1034-enum-default',
  'client-elicitation-sep1034-boolean-default'
];

let scenario: Scenario | undefined;

afterEach(async () => {
  await scenario?.stop();
  scenario = undefined;
});

/**
 * Drive `runClient` against the scenario in-process, the way the
 * everything-client would be spawned against it, and return the checks.
 */
async function runAgainst(
  runClient: (serverUrl: string) => Promise<void>
): Promise<ConformanceCheck[]> {
  scenario = getScenario(SCENARIO_NAME);
  if (!scenario) {
    throw new Error(`Scenario not found: ${SCENARIO_NAME}`);
  }
  const urls = await scenario.start(testScenarioContext());
  try {
    await runClient(urls.serverUrl);
  } finally {
    await scenario.stop();
  }
  return scenario.getChecks();
}

async function runClientWithoutElicitation(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'no-elicitation-test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  await client.callTool({
    name: 'test_client_elicitation_defaults',
    arguments: {}
  });
  await transport.close();
}

async function runRejectingElicitationClient(serverUrl: string): Promise<void> {
  // Declares the capability but registers no elicitation handler, so the
  // SDK answers `elicitation/create` with a method-not-found error.
  const client = new Client(
    { name: 'rejecting-elicitation-test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  await client.callTool({
    name: 'test_client_elicitation_defaults',
    arguments: {}
  });
  await transport.close();
}

describe('elicitation-sep1034-client-defaults capability gating', () => {
  test('client without the elicitation capability gets SKIPPED, not FAILURE', async () => {
    const checks = await runAgainst(runClientWithoutElicitation);

    const scored = checks.filter((c) =>
      c.id.startsWith(ELICITATION_CHECK_PREFIX)
    );
    expect(scored.length).toBe(DEFAULT_SLUGS.length + 1);
    expect(scored.every((c) => c.status === 'SKIPPED')).toBe(true);
    expect(checks.every((c) => c.status !== 'FAILURE')).toBe(true);
  });

  test('client declaring elicitation still receives elicitation/create', async () => {
    const checks = await runAgainst(runRejectingElicitationClient);

    // The request must actually be delivered: the client declares the
    // capability, so a refusal is a real FAILURE and nothing is SKIPPED.
    const general = checks.find(
      (c) => c.id === 'client-elicitation-sep1034-general'
    );
    expect(general?.status).toBe('FAILURE');
    expect(general?.errorMessage).toContain('Elicitation failed');
    expect(
      checks.some(
        (c) =>
          c.id.startsWith(ELICITATION_CHECK_PREFIX) && c.status === 'SKIPPED'
      )
    ).toBe(false);
  });
});
