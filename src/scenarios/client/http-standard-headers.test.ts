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

  it('does NOT emit an Mcp-Method check for notification POSTs', async () => {
    // Header rules for notification POSTs are explicitly undefined by the
    // spec, so a notification without Mcp-Method must not produce a row.
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });
      const checks = scenario.getChecks();
      const notifCheck = checks.find(
        (c) =>
          c.id === COARSE_ID &&
          c.name === 'ClientMcpMethodHeader_notifications_initialized'
      );
      expect(notifCheck).toBeUndefined();
    } finally {
      await scenario.stop();
    }
  });

  const BASE64_ID = 'sep-2243-client-base64-mcp-name';
  const UNICODE_TOOL_NAME = 'tööl_unicode';

  async function postToolsCall(
    serverUrl: string,
    toolName: string,
    extraHeaders: Record<string, string>
  ): Promise<void> {
    await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/call',
        ...extraHeaders
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: {} }
      })
    });
  }

  it('FAILs the Base64 Mcp-Name check when Mcp-Name is sent unencoded', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      // Node fetch() rejects raw non-ASCII header values, so use a header-safe
      // wrong value to exercise the "not Base64-sentinel-wrapped" branch.
      await postToolsCall(serverUrl, UNICODE_TOOL_NAME, {
        'Mcp-Name': 'tool_unicode'
      });
      const check = scenario.getChecks().find((c) => c.id === BASE64_ID);
      expect(check?.status).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('SUCCEEDs the Base64 Mcp-Name check when Mcp-Name is sentinel-encoded', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const encoded = `=?base64?${Buffer.from(UNICODE_TOOL_NAME, 'utf-8').toString('base64')}?=`;
      await postToolsCall(serverUrl, UNICODE_TOOL_NAME, {
        'Mcp-Name': encoded
      });
      const check = scenario.getChecks().find((c) => c.id === BASE64_ID);
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
