import { authScenariosList } from './index';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './test_helpers/testClient';
import { runClient as goodClient } from '../../../../examples/clients/typescript/auth-test';
import { runClient as badPrmClient } from '../../../../examples/clients/typescript/auth-test-bad-prm';
import { runClient as noCimdClient } from '../../../../examples/clients/typescript/auth-test-no-cimd';
import { runClient as ignoreScopeClient } from '../../../../examples/clients/typescript/auth-test-ignore-scope';
import { runClient as partialScopesClient } from '../../../../examples/clients/typescript/auth-test-partial-scopes';
import { runClient as ignore403Client } from '../../../../examples/clients/typescript/auth-test-ignore-403';
import { setLogLevel } from '../../../../examples/clients/typescript/helpers/logger';

beforeAll(() => {
  setLogLevel('error');
});

const skipScenarios = new Set<string>([
  // Waiting on typescript-sdk support in bearerAuth middleware to include
  // scope in WWW-Authenticate header
  // https://github.com/modelcontextprotocol/typescript-sdk/pull/1133
  'auth/scope-from-www-authenticate',
  // Waiting on typescript-sdk support for using scopes_supported from PRM
  // to request scopes.
  // https://github.com/modelcontextprotocol/typescript-sdk/pull/1133
  'auth/scope-from-scopes-supported',
  // Waiting on typescript-sdk support for CIMD
  // https://github.com/modelcontextprotocol/typescript-sdk/pull/1127
  'auth/basic-cimd'
]);

describe('Client Auth Scenarios', () => {
  // Generate individual test for each auth scenario
  for (const scenario of authScenariosList) {
    test(`${scenario.name} passes`, async () => {
      if (skipScenarios.has(scenario.name)) {
        // TODO: skip in a native way?
        return;
      }
      const runner = new InlineClientRunner(goodClient);
      await runClientAgainstScenario(runner, scenario.name);
    });
  }
});

describe('Negative tests', () => {
  test('bad client requests root PRM location', async () => {
    const runner = new InlineClientRunner(badPrmClient);
    await runClientAgainstScenario(runner, 'auth/basic-dcr', [
      'prm-priority-order'
    ]);
  });

  test('client ignores scope from WWW-Authenticate header', async () => {
    const runner = new InlineClientRunner(ignoreScopeClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-www-authenticate', [
      'scope-from-www-authenticate'
    ]);
  });

  test('client only requests subset of scopes_supported', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-scopes-supported', [
      'scope-from-scopes-supported'
    ]);
  });

  test('client requests scope even if scopes_supported is empty', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(
      runner,
      'auth/scope-omitted-when-undefined',
      ['scope-omitted-when-undefined']
    );
  });

  test('client only responds to 401, not 403', async () => {
    const runner = new InlineClientRunner(ignore403Client);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', [
      'scope-step-up-escalation'
    ]);
  });

  test('client uses DCR instead of CIMD when server supports it', async () => {
    const runner = new InlineClientRunner(noCimdClient);
    await runClientAgainstScenario(runner, 'auth/basic-cimd', [
      'cimd-client-id-used'
    ]);
  });
});
