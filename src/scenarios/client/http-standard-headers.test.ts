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
          protocolVersion: 'DRAFT-2026-v1',
          clientInfo: { name: 'neg-test', version: '0' },
          capabilities: {}
        }
      })
    });
  }

  it('FAILs sep-2243-mcp-method-header-initialize when Mcp-Method is missing', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      await postInitialize(serverUrl, {}); // no Mcp-Method header
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === 'sep-2243-mcp-method-header-initialize'
      );
      expect(check?.status).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('SUCCEEDs sep-2243-mcp-method-header-initialize when Mcp-Method matches', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      await postInitialize(serverUrl, { 'Mcp-Method': 'initialize' });
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === 'sep-2243-mcp-method-header-initialize'
      );
      expect(check?.status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });

  it('getChecks() is idempotent', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start();
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
