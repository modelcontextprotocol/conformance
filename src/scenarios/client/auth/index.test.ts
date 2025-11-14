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

  // TODO: Add more negative tests here
});
