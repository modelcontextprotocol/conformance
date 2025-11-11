import { runClientAgainstScenario } from './helpers/testClient.js';
import path from 'path';

describe('OAuth Metadata at OpenID Configuration Path', () => {
  test('client discovers OAuth metadata at OpenID configuration path', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test.ts'
    );
    await runClientAgainstScenario(clientPath, 'auth/basic-metadata-var1');
  });
});
