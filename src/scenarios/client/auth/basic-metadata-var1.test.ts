import { describe, test } from '@jest/globals';
import {
  runClientAgainstScenario,
  SpawnedClientRunner
} from './test_helpers/testClient.js';
import path from 'path';

describe('OAuth Metadata at OpenID Configuration Path', () => {
  test('client discovers OAuth metadata at OpenID configuration path', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test.ts'
    );
    const runner = new SpawnedClientRunner(clientPath);
    await runClientAgainstScenario(runner, 'auth/basic-metadata-var1');
  });
});
