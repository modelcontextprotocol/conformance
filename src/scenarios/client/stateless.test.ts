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

// A client that flips versions between requests
async function flippingVersionClient(serverUrl: string) {
  const metaA = {
    'io.modelcontextprotocol/protocolVersion': 'DRAFT-2026-v1',
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
  const metaB = {
    ...metaA,
    'io.modelcontextprotocol/protocolVersion': '2025-11-25'
  };

  // Send first request
  await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': 'DRAFT-2026-v1'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: metaA }
    })
  });

  // Send second request with different version
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: metaB }
    })
  });
  return response.json();
}

// A client that misses the HTTP header
async function missingHeaderClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // Missing MCP-Protocol-Version header
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': 'DRAFT-2026-v1',
          'io.modelcontextprotocol/clientInfo': {
            name: 'test',
            version: '1.0'
          },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  return response.json();
}

describe('Stateless Client Scenario Negative Tests', () => {
  test('client fails when omitting _meta', async () => {
    const runner = new InlineClientRunner(badClient);
    await runClientAgainstScenario(runner, 'stateless-client', {
      expectedFailureSlugs: ['client-populates-meta']
    });
  });

  test('client fails when flipping versions', async () => {
    const runner = new InlineClientRunner(flippingVersionClient);
    await runClientAgainstScenario(runner, 'stateless-client', {
      expectedFailureSlugs: ['client-consistent-version']
    });
  });

  test('client fails when missing version header', async () => {
    const runner = new InlineClientRunner(missingHeaderClient);
    await runClientAgainstScenario(runner, 'stateless-client', {
      expectedFailureSlugs: ['client-sends-version-header']
    });
  });
});
