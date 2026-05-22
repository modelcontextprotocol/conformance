import { describe, it, expect } from 'vitest';
import {
  HttpCustomHeadersScenario,
  HttpInvalidToolHeadersScenario,
  CUSTOM_HEADERS_DECLARED_CHECK_IDS,
  INVALID_TOOL_DECLARED_CHECK_IDS
} from './http-custom-headers';

/**
 * Pins the SEP-2243 requirement-level check IDs emitted by the custom-header
 * client scenarios so the traceability manifest's join (yaml `check:` ==
 * emitted id) cannot silently drift again. Each declared ID must be emitted
 * on every run — exercised, backfilled as FAILURE, or SKIPPED — never absent.
 */

async function post(
  serverUrl: string,
  body: object,
  headers: Record<string, string> = {}
): Promise<void> {
  await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function idsOf(checks: { id: string }[]): Set<string> {
  return new Set(checks.map((c) => c.id));
}

function statusesFor(
  checks: { id: string; status: string }[],
  id: string
): string[] {
  return checks.filter((c) => c.id === id).map((c) => c.status);
}

describe('HttpCustomHeadersScenario (SEP-2243) check IDs', () => {
  it('emits exactly the declared requirement IDs as FAILURE when the client never connects', async () => {
    const scenario = new HttpCustomHeadersScenario();
    await scenario.start();
    try {
      const checks = scenario.getChecks();
      expect(idsOf(checks)).toEqual(new Set(CUSTOM_HEADERS_DECLARED_CHECK_IDS));
      for (const check of checks) {
        expect(check.status).toBe('FAILURE');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('maps each parameter kind to its requirement ID on a conforming tool call', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      const nonAscii = 'Hello, 世界';
      const nonAsciiB64 = Buffer.from(nonAscii, 'utf-8').toString('base64');
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers',
            arguments: {
              region: 'us-west1',
              priority: 42,
              non_ascii_val: nonAscii,
              query: 'SELECT 1'
            }
          }
        },
        {
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'test_custom_headers',
          'Mcp-Param-Region': 'us-west1',
          'Mcp-Param-Priority': '42',
          'Mcp-Param-NonAscii': `=?base64?${nonAsciiB64}?=`
        }
      );
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers_null',
            arguments: {
              region: 'us-east1',
              priority: 1,
              verbose: null,
              query: 'SELECT 1'
            }
          }
        },
        {
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'test_custom_headers_null',
          'Mcp-Param-Region': 'us-east1',
          'Mcp-Param-Priority': '1'
          // Mcp-Param-Verbose deliberately omitted: value is null
        }
      );

      const checks = scenario.getChecks();
      for (const id of CUSTOM_HEADERS_DECLARED_CHECK_IDS) {
        const statuses = statusesFor(checks, id);
        expect(statuses.length, id).toBeGreaterThan(0);
        expect(statuses, id).not.toContain('FAILURE');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('FAILs client-mirrors-designated-params when an annotated header is missing', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers',
            arguments: { region: 'us-west1', priority: 42, query: 'SELECT 1' }
          }
        },
        {
          // Mcp-Param-Region deliberately omitted
          'Mcp-Param-Priority': '42'
        }
      );
      const checks = scenario.getChecks();
      expect(
        statusesFor(checks, 'sep-2243-client-mirrors-designated-params')
      ).toContain('FAILURE');
    } finally {
      await scenario.stop();
    }
  });
});

describe('HttpInvalidToolHeadersScenario (SEP-2243) check IDs', () => {
  it('emits every x-mcp-header constraint ID, SUCCESS when only valid_tool is called', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      await post(serverUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'valid_tool', arguments: { region: 'us-west1' } }
      });
      const checks = scenario.getChecks();
      for (const id of INVALID_TOOL_DECLARED_CHECK_IDS) {
        const statuses = statusesFor(checks, id);
        expect(statuses.length, id).toBeGreaterThan(0);
        expect(statuses, id).not.toContain('FAILURE');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('FAILs the violated constraint ID when the client calls an invalid tool', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start();
    try {
      await post(serverUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'invalid_empty_header', arguments: { value: 'x' } }
      });
      const checks = scenario.getChecks();
      expect(statusesFor(checks, 'sep-2243-x-mcp-header-not-empty')).toContain(
        'FAILURE'
      );
      // The other constraints were not violated.
      expect(
        statusesFor(checks, 'sep-2243-x-mcp-header-charset')
      ).not.toContain('FAILURE');
    } finally {
      await scenario.stop();
    }
  });
});
