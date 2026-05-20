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

describe('MRTR client scenario (SEP-2322)', () => {
  test('everything-client passes mrtr-client-request-state scenario', async () => {
    const clientFn = getHandler('mrtr-client-request-state');
    if (!clientFn) {
      throw new Error(
        'No handler registered for scenario: mrtr-client-request-state'
      );
    }

    const scenario = getScenario('mrtr-client-request-state');
    if (!scenario) {
      throw new Error('Scenario not found: mrtr-client-request-state');
    }

    const runner = new InlineClientRunner(clientFn);
    await runClientAgainstScenario(runner, 'mrtr-client-request-state');

    const checks = scenario.getChecks();

    for (const check of checks) {
      expect(
        check.status,
        `Check "${check.id}" failed: ${check.errorMessage ?? ''}`
      ).toBe('SUCCESS');
    }
  });
});
