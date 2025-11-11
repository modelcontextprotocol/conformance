import { runClientAgainstScenario } from './helpers/testClient.js';
import path from 'path';

describe('PRM Path-Based Discovery', () => {
  test('client discovers PRM at path-based location before root', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test.ts'
    );
    await runClientAgainstScenario(clientPath, 'auth/basic-dcr');
  });
});
