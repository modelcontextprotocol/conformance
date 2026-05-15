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

const goodMeta = {
  'io.modelcontextprotocol/protocolVersion': 'DRAFT-2026-v1',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

// A client that misses the HTTP header
async function missingHeaderClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // Missing MCP-Protocol-Version header
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: goodMeta }
    })
  });
  return response.json();
}

// A client whose header disagrees with _meta.protocolVersion
async function mismatchedHeaderClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25' // != _meta.protocolVersion
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: goodMeta }
    })
  });
  return response.json();
}

describe('Stateless Client Scenario Negative Tests', () => {
  test('client fails when omitting _meta', async () => {
    const runner = new InlineClientRunner(badClient);
    await runClientAgainstScenario(runner, 'stateless', {
      expectedFailureSlugs: [
        'sep-2575-client-populates-meta',
        'sep-2575-http-client-sends-version-header'
      ]
    });
  });

  test('client fails when missing version header', async () => {
    const runner = new InlineClientRunner(missingHeaderClient);
    await runClientAgainstScenario(runner, 'stateless', {
      expectedFailureSlugs: ['sep-2575-http-client-sends-version-header']
    });
  });

  test('client fails when header disagrees with _meta', async () => {
    const runner = new InlineClientRunner(mismatchedHeaderClient);
    await runClientAgainstScenario(runner, 'stateless', {
      expectedFailureSlugs: ['sep-2575-http-version-header-matches-meta']
    });
  });
});
