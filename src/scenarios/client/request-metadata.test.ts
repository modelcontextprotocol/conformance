import { testScenarioContext } from '../../mock-server/testing';
import { describe, test, expect } from 'vitest';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { getScenario } from '../index';
import { DECLARED_CHECK_IDS } from './request-metadata';

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
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
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

// A client that fails to negotiate/retry on a 400 response
async function nonRetryingClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28'
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

// A client that has empty version intersection and terminates
async function incompatibleVersionClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': 'UNSUPPORTED-VERSION'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          ...goodMeta,
          'io.modelcontextprotocol/protocolVersion': 'UNSUPPORTED-VERSION'
        }
      }
    })
  });

  if (response.status === 400) {
    const body = await response.json();
    if (body.error?.code === -32022) {
      return body; // Abort cleanly
    }
  }
  return response.json();
}

// A client that sends invalid (non-object) capabilities
async function malformedCapabilitiesClient(serverUrl: string) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          ...goodMeta,
          'io.modelcontextprotocol/clientCapabilities': {
            roots: 'malformed-string',
            sampling: {},
            elicitation: true
          }
        }
      }
    })
  });
  return response.json();
}

describe('request-metadata client scenario — positive test', () => {
  test('everything-client passes request-metadata scenario with success status for optional capabilities', async () => {
    const clientFn = getHandler('request-metadata');
    if (!clientFn) {
      throw new Error('No handler registered for scenario: request-metadata');
    }

    const scenario = getScenario('request-metadata');
    if (!scenario) {
      throw new Error('Scenario not found');
    }

    const runner = new InlineClientRunner(clientFn);
    await runClientAgainstScenario(runner, 'request-metadata');

    // Extract checks directly from the scenario instance
    const checks = scenario.getChecks();

    // 4-Line Bulk Assertion Loop
    for (const check of checks) {
      expect(check.status).not.toBe('FAILURE');
      expect(check.status).not.toBe('WARNING');
    }

    // Strategic Targeted Optional Assertions
    expect(
      checks.find((c) => c.id === 'sep-2575-client-declares-roots-capability')
        ?.status
    ).toBe('SUCCESS');
    expect(
      checks.find(
        (c) => c.id === 'sep-2575-client-declares-sampling-capability'
      )?.status
    ).toBe('SUCCESS');
    expect(
      checks.find(
        (c) => c.id === 'sep-2575-client-declares-elicitation-capability'
      )?.status
    ).toBe('SUCCESS');

    // Assert version negotiation retry succeeded
    expect(
      checks.find((c) => c.id === 'sep-2575-client-retry-supported-version')
        ?.status
    ).toBe('SUCCESS');

    // Declared ↔ emitted completeness, both directions: every declared check
    // is genuinely observed, and every emitted check is declared.
    for (const check of checks) {
      expect(DECLARED_CHECK_IDS).toContain(check.id);
      expect(check.errorMessage ?? '').not.toContain('not observed');
    }
    expect(new Set(checks.map((c) => c.id))).toEqual(
      new Set(DECLARED_CHECK_IDS)
    );
  });
});

describe('request-metadata client scenario — client never connects', () => {
  // A client with no handler for this scenario exits without sending a
  // request. Every declared check must still be emitted (as FAILURE) instead
  // of reporting "0 passed, 0 failed".
  test('emits every declared check as FAILURE when no request is received', async () => {
    const scenario = getScenario('request-metadata');
    if (!scenario) {
      throw new Error('Scenario not found');
    }

    await scenario.start(testScenarioContext());
    try {
      const checks = scenario.getChecks();
      const byId = new Map(checks.map((c) => [c.id, c]));

      for (const id of DECLARED_CHECK_IDS) {
        const check = byId.get(id);
        expect(check, `expected check ${id} to be emitted`).toBeDefined();
        expect(check?.status, `expected ${id} to be FAILURE`).toBe('FAILURE');
        expect(check?.errorMessage).toContain('never sent a request');
      }
      expect(checks).toHaveLength(DECLARED_CHECK_IDS.length);
    } finally {
      await scenario.stop();
    }
  });

  test('does not overwrite checks recorded from a real request', async () => {
    const runner = new InlineClientRunner(badClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: [
        'sep-2575-client-populates-meta',
        'sep-2575-http-client-sends-version-header'
      ]
    });

    const scenario = getScenario('request-metadata');
    const checks = scenario!.getChecks();
    // badClient connects, so its failures must carry the observed request's
    // details, not the "never sent a request" backfill.
    const populatesMeta = checks.find(
      (c) => c.id === 'sep-2575-client-populates-meta'
    );
    expect(populatesMeta?.errorMessage ?? '').not.toContain(
      'never sent a request'
    );
  });
});

describe('request-metadata client scenario — negative tests', () => {
  test('client fails when omitting _meta', async () => {
    const runner = new InlineClientRunner(badClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: [
        'sep-2575-client-populates-meta',
        'sep-2575-http-client-sends-version-header'
      ]
    });
  });

  test('client fails when missing version header', async () => {
    const runner = new InlineClientRunner(missingHeaderClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: ['sep-2575-http-client-sends-version-header']
    });
  });

  test('client fails when header disagrees with _meta', async () => {
    const runner = new InlineClientRunner(mismatchedHeaderClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: ['sep-2575-http-version-header-matches-meta']
    });
  });

  test('client fails retry check when it does not handle 400 rejection', async () => {
    const runner = new InlineClientRunner(nonRetryingClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: ['sep-2575-client-retry-supported-version']
    });
  });

  test('client aborts cleanly without hanging when negotiation has empty version intersection', async () => {
    const runner = new InlineClientRunner(incompatibleVersionClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: ['sep-2575-client-retry-supported-version']
    });
  });

  test('client triggers failures for malformed capabilities', async () => {
    const runner = new InlineClientRunner(malformedCapabilitiesClient);
    await runClientAgainstScenario(runner, 'request-metadata', {
      expectedFailureSlugs: [
        'sep-2575-client-declares-roots-capability',
        'sep-2575-client-declares-elicitation-capability'
      ]
    });
  });
});
