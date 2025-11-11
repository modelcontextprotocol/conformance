import {
  runClientAgainstScenario,
  SpawnedClientRunner
} from './test_helpers/testClient.js';
import path from 'path';

describe('PRM Path-Based Discovery', () => {
  test('client discovers PRM at path-based location before root', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/basic-dcr');
  });

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
});
