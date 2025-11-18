import { authScenariosList } from './index.js';
import {
  runClientAgainstScenario,
  SpawnedClientRunner
} from './test_helpers/testClient.js';
import path from 'path';

describe('Client Auth Scenarios', () => {
  const clientPath = path.join(
    process.cwd(),
    'examples/clients/typescript/auth-test.ts'
  );

  // Generate individual test for each auth scenario
  for (const scenario of authScenariosList) {
    test(`${scenario.name} passes`, async () => {
      const runner = new SpawnedClientRunner(clientPath);
      await runClientAgainstScenario(runner, scenario.name);
    });
  }
});

describe('Negative tests', () => {
  test('bad client requests root PRM location', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test-broken1.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/basic-dcr', [
      // There will be other failures, but this is the one that matters
      'prm-priority-order'
    ]);
  });

  test('client ignores scope from WWW-Authenticate header', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test-scope-broken.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/scope-from-www-authenticate', [
      'scope-from-www-authenticate'
    ]);
  });

  test('client only requests subset of scopes_supported', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test-scopes-supported-broken.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/scope-from-scopes-supported', [
      'scope-from-scopes-supported'
    ]);
  });

  test('client requests scope even if scopes_supported is empty', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test-scopes-supported-broken.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(
      runner,
      'auth/scope-omitted-when-undefined',
      ['scope-omitted-when-undefined']
    );
  });

  test('client only responds to 401, not 403', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test-scope-stepup-broken.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', [
      'scope-step-up-escalation'
    ]);
  });
});
