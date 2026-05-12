import { describe, test } from 'vitest';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';

// A bad client that does not send _meta
async function badClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {} // Missing _meta
    })
  });
  return response.json();
}

describe('Stateless Client Scenario Negative Tests', () => {
  test('client fails when omitting _meta', async () => {
    const runner = new InlineClientRunner(badClient);

    // runClientAgainstScenario searches for the scenario by name in the registry
    await runClientAgainstScenario(runner, 'stateless-client', {
      expectedFailureSlugs: ['client-populates-meta']
    });
  });
});
