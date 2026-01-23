import { authScenariosList } from './index';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './test_helpers/testClient';
import { runClient as badPrmClient } from '../../../../examples/clients/typescript/auth-test-bad-prm';
import { runClient as noCimdClient } from '../../../../examples/clients/typescript/auth-test-no-cimd';
import { runClient as ignoreScopeClient } from '../../../../examples/clients/typescript/auth-test-ignore-scope';
import { runClient as partialScopesClient } from '../../../../examples/clients/typescript/auth-test-partial-scopes';
import { runClient as ignore403Client } from '../../../../examples/clients/typescript/auth-test-ignore-403';
import { runClient as noRetryLimitClient } from '../../../../examples/clients/typescript/auth-test-no-retry-limit';
import { getHandler } from '../../../../examples/clients/typescript/everything-client';
import { setLogLevel } from '../../../../examples/clients/typescript/helpers/logger';

beforeAll(() => {
  setLogLevel('error');
});

const skipScenarios = new Set<string>([
  // Add scenarios that should be skipped here
]);

const allowClientErrorScenarios = new Set<string>([
  // Client is expected to give up (error) after limited retries, but check should pass
  'auth/scope-retry-limit',
  // Client is expected to error when PRM resource doesn't match server URL
  'auth/resource-mismatch'
]);

describe('Client Auth Scenarios', () => {
  // Generate individual test for each auth scenario
  for (const scenario of authScenariosList) {
    test(`${scenario.name} passes`, async () => {
      if (skipScenarios.has(scenario.name)) {
        // TODO: skip in a native way?
        return;
      }
      const clientFn = getHandler(scenario.name);
      if (!clientFn) {
        throw new Error(`No handler registered for scenario: ${scenario.name}`);
      }
      const runner = new InlineClientRunner(clientFn);
      await runClientAgainstScenario(runner, scenario.name, {
        allowClientError: allowClientErrorScenarios.has(scenario.name)
      });
    });
  }
});

describe('Negative tests', () => {
  test('bad client requests root PRM location', async () => {
    const runner = new InlineClientRunner(badPrmClient);
    await runClientAgainstScenario(runner, 'auth/metadata-default', {
      expectedFailureSlugs: ['prm-priority-order']
    });
  });

  test('client ignores scope from WWW-Authenticate header', async () => {
    const runner = new InlineClientRunner(ignoreScopeClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-www-authenticate', {
      expectedFailureSlugs: ['scope-from-www-authenticate']
    });
  });

  test('client only requests subset of scopes_supported', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-scopes-supported', {
      expectedFailureSlugs: ['scope-from-scopes-supported']
    });
  });

  test('client requests scope even if scopes_supported is empty', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(
      runner,
      'auth/scope-omitted-when-undefined',
      {
        expectedFailureSlugs: ['scope-omitted-when-undefined']
      }
    );
  });

  test('client only responds to 401, not 403', async () => {
    const runner = new InlineClientRunner(ignore403Client);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', {
      expectedFailureSlugs: ['scope-step-up-escalation']
    });
  });

  test('client uses DCR instead of CIMD when server supports it', async () => {
    const runner = new InlineClientRunner(noCimdClient);
    await runClientAgainstScenario(runner, 'auth/basic-cimd', {
      expectedFailureSlugs: ['cimd-client-id-used']
    });
  });

  test('client retries auth infinitely without limit', async () => {
    const runner = new InlineClientRunner(noRetryLimitClient);
    await runClientAgainstScenario(runner, 'auth/scope-retry-limit', {
      expectedFailureSlugs: ['scope-retry-limit'],
      allowClientError: true
    });
  });
});
