import { describe, test } from '@jest/globals';
import {
  runClientAgainstScenario,
  SpawnedClientRunner
} from './test_helpers/testClient.js';
import path from 'path';
// import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// import { ConformanceOAuthProvider } from '../../../examples/clients/typescript/helpers/ConformanceOAuthProvider.js';
// import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

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
      'authorization-request',
      'authorization-server-metadata',
      'client-registration',
      'prm-pathbased-requested',
      'prm-priority-order',
      'token-request'
    ]);
  });
});
