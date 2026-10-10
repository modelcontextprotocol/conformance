/**
 * Integration test for MRTR client conformance scenario (SEP-2322).
 *
 * Runs the everything-client's MRTR handler in-process against the scenario server
 * and verifies all checks pass.
 */
import { describe, test, expect } from 'vitest';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { getScenario } from '../index';

const STATE_ONLY_CHECK = 'sep-2322-client-request-state-only-echoed';

async function callStateOnlyTool(
  serverUrl: string,
  id: number,
  extraParams: Record<string, unknown> = {}
): Promise<Record<string, unknown> | undefined> {
  const resp = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'test_mrtr_state_only', arguments: {}, ...extraParams }
    })
  });
  const body = (await resp.json()) as { result?: Record<string, unknown> };
  return body.result;
}

// Retries the requestState-only round without echoing the state.
async function stateDroppingClient(serverUrl: string): Promise<void> {
  await callStateOnlyTool(serverUrl, 1);
  await callStateOnlyTool(serverUrl, 2);
}

// Re-serializes the state before echoing it.
async function stateRewritingClient(serverUrl: string): Promise<void> {
  const result = await callStateOnlyTool(serverUrl, 1);
  const state = result?.requestState as string;
  await callStateOnlyTool(serverUrl, 2, {
    requestState: JSON.stringify(JSON.parse(state), null, 1)
  });
}

// Treats a result without inputRequests as final and never retries.
async function nonRetryingClient(serverUrl: string): Promise<void> {
  await callStateOnlyTool(serverUrl, 1);
}

describe('MRTR client scenario (SEP-2322)', () => {
  test('everything-client passes sep-2322-client-request-state scenario', async () => {
    const clientFn = getHandler('sep-2322-client-request-state');
    if (!clientFn) {
      throw new Error(
        'No handler registered for scenario: sep-2322-client-request-state'
      );
    }

    const scenario = getScenario('sep-2322-client-request-state');
    if (!scenario) {
      throw new Error('Scenario not found: sep-2322-client-request-state');
    }

    const runner = new InlineClientRunner(clientFn);
    await runClientAgainstScenario(runner, 'sep-2322-client-request-state');

    const checks = scenario.getChecks();

    for (const check of checks) {
      expect(
        check.status,
        `Check "${check.id}" failed: ${check.errorMessage ?? ''}`
      ).toBe('SUCCESS');
    }
  });

  test('a client that drops requestState on a requestState-only retry fails', async () => {
    const checks = await runClientAgainstScenario(
      new InlineClientRunner(stateDroppingClient),
      'sep-2322-client-request-state',
      { expectedFailureSlugs: [STATE_ONLY_CHECK] }
    );
    expect(checks.find((c) => c.id === STATE_ONLY_CHECK)?.errorMessage).toBe(
      'Client did not include requestState in retry'
    );
  });

  test('a client that rewrites requestState on a requestState-only retry fails', async () => {
    const checks = await runClientAgainstScenario(
      new InlineClientRunner(stateRewritingClient),
      'sep-2322-client-request-state',
      { expectedFailureSlugs: [STATE_ONLY_CHECK] }
    );
    expect(
      checks.find((c) => c.id === STATE_ONLY_CHECK)?.errorMessage
    ).toContain('requestState was not echoed back exactly');
  });

  test('a client that never retries a requestState-only result fails', async () => {
    const checks = await runClientAgainstScenario(
      new InlineClientRunner(nonRetryingClient),
      'sep-2322-client-request-state',
      { expectedFailureSlugs: [STATE_ONLY_CHECK] }
    );
    const check = checks.find((c) => c.id === STATE_ONLY_CHECK);
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toMatch(/^Not testable: /);
    expect(check?.details?.untestable).toBe(true);
  });
});
