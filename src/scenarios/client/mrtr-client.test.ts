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
import { MRTRClientScenario } from './mrtr-client';
import { testScenarioContext } from '../../mock-server/testing';

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

    for (const check of checks.filter((c) => c.status !== 'INFO')) {
      expect(
        check.status,
        `Check "${check.id}" failed: ${check.errorMessage ?? ''}`
      ).toBe('SUCCESS');
    }
  });
});

describe('MRTR echo-state without shared memory', () => {
  // Two scenario instances share no memory, like two processes of a
  // serverless host: the first call and its retry land on different ones.
  async function started() {
    const s = new MRTRClientScenario();
    const { serverUrl } = await s.start(testScenarioContext());
    return {
      s,
      url: serverUrl.endsWith('/mcp') ? serverUrl : `${serverUrl}/mcp`
    };
  }

  async function call(
    url: string,
    id: number,
    name: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ result: Record<string, unknown> }> {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: {}, ...extra }
      })
    });
    return (await r.json()) as { result: Record<string, unknown> };
  }

  const confirmed = {
    inputResponses: {
      confirm: { action: 'accept', content: { confirmed: true } }
    }
  };
  const status = (s: MRTRClientScenario, id: string) =>
    s.getChecks().find((c) => c.id === id)?.status;

  test('judges a retry that lands on a different process', async () => {
    const a = await started();
    const b = await started();
    try {
      const first = await call(a.url, 1, 'test_mrtr_echo_state');
      const state = first.result.requestState as string;
      expect(typeof state).toBe('string');
      await call(b.url, 2, 'test_mrtr_echo_state', {
        ...confirmed,
        requestState: state
      });
      expect(status(b.s, 'sep-2322-client-request-state-echoed')).toBe(
        'SUCCESS'
      );
      expect(status(b.s, 'sep-2322-client-jsonrpc-id-different')).toBe(
        'SUCCESS'
      );
    } finally {
      await a.s.stop();
      await b.s.stop();
    }
  });

  test('fails a requestState that was re-serialized or edited', async () => {
    const a = await started();
    try {
      const first = await call(a.url, 1, 'test_mrtr_echo_state');
      const parsed = JSON.parse(first.result.requestState as string);
      const changed = [
        JSON.stringify(parsed, null, 1),
        JSON.stringify({ ...parsed, originalId: 99 })
      ];
      for (const requestState of changed) {
        const b = await started();
        try {
          await call(b.url, 2, 'test_mrtr_echo_state', {
            ...confirmed,
            requestState
          });
          expect(status(b.s, 'sep-2322-client-request-state-echoed')).toBe(
            'FAILURE'
          );
        } finally {
          await b.s.stop();
        }
      }
    } finally {
      await a.s.stop();
    }
  });

  test('still catches a reused request id when the retry drops the state', async () => {
    const a = await started();
    try {
      await call(a.url, 7, 'test_mrtr_echo_state');
      await call(a.url, 7, 'test_mrtr_echo_state', confirmed);
      expect(status(a.s, 'sep-2322-client-request-state-echoed')).toBe(
        'FAILURE'
      );
      expect(status(a.s, 'sep-2322-client-jsonrpc-id-different')).toBe(
        'FAILURE'
      );
    } finally {
      await a.s.stop();
    }
  });

  test('reports one row for a retried no-result-type call', async () => {
    const a = await started();
    try {
      await call(a.url, 1, 'test_mrtr_no_result_type');
      await call(a.url, 2, 'test_mrtr_no_result_type', { inputResponses: {} });
      const rows = a.s
        .getChecks()
        .filter((c) => c.id === 'sep-2322-default-result-type-complete');
      expect(rows.map((c) => c.status)).toEqual(['FAILURE']);
    } finally {
      await a.s.stop();
    }
  });
});
