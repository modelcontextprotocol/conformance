import { testScenarioContext } from '../../mock-server/testing';
import { describe, it, expect } from 'vitest';
import { HttpStandardHeadersScenario } from './http-standard-headers';

/**
 * Negative test for SEP-2243 standard-header checks: a client that omits
 * Mcp-Method on a POST must produce a FAILURE row, and one that includes it
 * must produce SUCCESS. Pins the check id so coverage is tracked.
 */
describe('HttpStandardHeadersScenario (SEP-2243) — negative', () => {
  async function postInitialize(
    serverUrl: string,
    extraHeaders: Record<string, string>
  ): Promise<void> {
    await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          clientInfo: { name: 'neg-test', version: '0' },
          capabilities: {}
        }
      })
    });
  }

  // The coarse check id is emitted once per method/name case, so we narrow to
  // the initialize Mcp-Method emission via its (case-specific) name.
  const COARSE_ID = 'sep-2243-client-includes-standard-headers';
  const INIT_METHOD_NAME = 'ClientMcpMethodHeader_initialize';

  it('FAILs the initialize Mcp-Method emission when Mcp-Method is missing', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await postInitialize(serverUrl, {}); // no Mcp-Method header
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === COARSE_ID && c.name === INIT_METHOD_NAME
      );
      expect(check?.status).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('SUCCEEDs the initialize Mcp-Method emission when Mcp-Method matches', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await postInitialize(serverUrl, { 'Mcp-Method': 'initialize' });
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === COARSE_ID && c.name === INIT_METHOD_NAME
      );
      expect(check?.status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });

  it('getChecks() is idempotent', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await postInitialize(serverUrl, { 'Mcp-Method': 'initialize' });
      const first = scenario.getChecks();
      const second = scenario.getChecks();
      expect(second.length).toBe(first.length);
    } finally {
      await scenario.stop();
    }
  });
});
