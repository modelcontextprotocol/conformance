import { testScenarioContext } from '../../mock-server/testing';
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
): Promise<{ status: number; body: any }> {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function postJson(serverUrl: string, body: object): Promise<any> {
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  });
  return res.json();
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
    await scenario.start(testScenarioContext());
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

  it.each([false, true])(
    'isolates range probe rejection (rejected: %s) from ordinary header checks',
    async (rejectProbe) => {
      const scenario = new HttpCustomHeadersScenario();
      const { serverUrl } = await scenario.start(testScenarioContext());
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

        if (!rejectProbe) {
          await post(serverUrl, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'test_custom_headers_unsafe_integer',
              arguments: { unsafe_integer_val: 9007199254740992 }
            }
          });
        }

        const checks = scenario.getChecks();
        expect(idsOf(checks)).toEqual(
          new Set(CUSTOM_HEADERS_DECLARED_CHECK_IDS)
        );
        for (const id of CUSTOM_HEADERS_DECLARED_CHECK_IDS) {
          const statuses = statusesFor(checks, id);
          if (
            rejectProbe &&
            id === 'sep-2243-x-mcp-header-integer-safe-range'
          ) {
            expect(statuses).toEqual(['FAILURE']);
            const check = checks.find((c) => c.id === id)!;
            expect(check.details?.untestable).toBe(true);
            expect(check.errorMessage).toContain(
              'test_custom_headers_unsafe_integer'
            );
            expect(check.errorMessage).toContain(
              'rejected the argument locally'
            );
            continue;
          }
          expect(statuses.length, id).toBeGreaterThan(0);
          expect(statuses, id).not.toContain('FAILURE');
        }
        const checkCount = checks.length;
        expect(scenario.getChecks()).toHaveLength(checkCount);
      } finally {
        await scenario.stop();
      }
    }
  );

  it('FAILs client-mirrors-designated-params when an annotated header is missing', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
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

  it('serves a fresh tools/list TTL before requiring schema-derived custom headers', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const toolsList = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });
      const schemaIsFresh = toolsList.body.result.ttlMs > 0;

      const nonAscii = 'Hello, 世界';
      const nonAsciiB64 = Buffer.from(nonAscii, 'utf-8').toString('base64');
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 2,
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
        schemaIsFresh
          ? {
              'Mcp-Method': 'tools/call',
              'Mcp-Name': 'test_custom_headers',
              'Mcp-Param-Region': 'us-west1',
              'Mcp-Param-Priority': '42',
              'Mcp-Param-NonAscii': `=?base64?${nonAsciiB64}?=`
            }
          : {}
      );
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 3,
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
        schemaIsFresh
          ? {
              'Mcp-Method': 'tools/call',
              'Mcp-Name': 'test_custom_headers_null',
              'Mcp-Param-Region': 'us-east1',
              'Mcp-Param-Priority': '1'
            }
          : {}
      );

      await post(serverUrl, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'test_custom_headers_unsafe_integer',
          arguments: { unsafe_integer_val: 9007199254740992 }
        }
      });

      expect(toolsList.body.result.ttlMs).toBeGreaterThan(0);
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

  it('FAILs safe-integer-range when a client mirrors an out-of-range integer header', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers_unsafe_integer',
            arguments: { unsafe_integer_val: 9007199254740992 }
          }
        },
        {
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'test_custom_headers_unsafe_integer',
          'Mcp-Param-UnsafeInteger': '9007199254740992'
        }
      );
      const checks = scenario.getChecks();
      expect(
        statusesFor(checks, 'sep-2243-x-mcp-header-integer-safe-range')
      ).toContain('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('PASSes safe-integer-range when a client omits the out-of-range integer header', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers_unsafe_integer',
            arguments: { unsafe_integer_val: 9007199254740992 }
          }
        },
        {
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'test_custom_headers_unsafe_integer'
          // Mcp-Param-UnsafeInteger is deliberately omitted
        }
      );
      const checks = scenario.getChecks();
      expect(
        statusesFor(checks, 'sep-2243-x-mcp-header-integer-safe-range')
      ).toContain('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });
});

describe('HttpCustomHeadersScenario range probe', () => {
  it('advertises a dedicated integer tool and schedules it after the ordinary calls', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl, context } = await scenario.start(testScenarioContext());
    try {
      const toolCalls = context!.toolCalls as Array<{
        name: string;
        arguments: Record<string, unknown>;
      }>;
      expect(toolCalls.map((call) => call.name)).toEqual([
        'test_custom_headers',
        'test_custom_headers_null',
        'test_custom_headers_unsafe_integer'
      ]);
      expect(toolCalls[0].arguments).not.toHaveProperty('unsafe_integer_val');
      expect(toolCalls[2].arguments).toEqual({
        unsafe_integer_val: 9007199254740992
      });
      const listed = await postJson(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });
      const tools = listed.result.tools;
      expect(tools[0].inputSchema.properties).not.toHaveProperty(
        'unsafe_integer_val'
      );
      expect(tools[2]).toMatchObject({
        name: 'test_custom_headers_unsafe_integer',
        inputSchema: {
          properties: {
            unsafe_integer_val: {
              type: 'integer',
              'x-mcp-header': 'UnsafeInteger'
            }
          },
          required: ['unsafe_integer_val']
        }
      });
    } finally {
      await scenario.stop();
    }
  });

  it.each([undefined, null, 42, '9007199254740992'])(
    'does not pass when the client changes or omits the probe argument (%s)',
    async (value) => {
      const scenario = new HttpCustomHeadersScenario();
      const { serverUrl } = await scenario.start(testScenarioContext());
      try {
        await post(serverUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'test_custom_headers_unsafe_integer',
            arguments: { unsafe_integer_val: value }
          }
        });
        const checks = scenario
          .getChecks()
          .filter((c) => c.id === 'sep-2243-x-mcp-header-integer-safe-range');
        expect(checks).toHaveLength(1);
        expect(checks[0].status).toBe('FAILURE');
        expect(checks[0].details?.untestable).toBe(true);
      } finally {
        await scenario.stop();
      }
    }
  );
});

describe('HttpInvalidToolHeadersScenario (SEP-2243) check IDs', () => {
  it('emits every x-mcp-header constraint ID, SUCCESS when only valid_tool is called', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
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
    const { serverUrl } = await scenario.start(testScenarioContext());
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

  it('FAILs primitive-only when the client calls the number-typed tool', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const listed = await postJson(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });
      // SEP-2243 permits x-mcp-header only on integer/string/boolean, so the
      // number-typed tool must be served for the client to reject it.
      const numberTool = listed.result.tools.find(
        (t: { name: string }) => t.name === 'invalid_number_header'
      );
      expect(numberTool?.inputSchema.properties.score).toEqual({
        type: 'number',
        'x-mcp-header': 'Score'
      });

      await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'invalid_number_header', arguments: { score: 1.5 } }
      });
      const checks = scenario.getChecks();
      expect(
        statusesFor(checks, 'sep-2243-x-mcp-header-primitive-only')
      ).toContain('FAILURE');
      // The other constraints were not violated.
      expect(
        statusesFor(checks, 'sep-2243-x-mcp-header-not-empty')
      ).not.toContain('FAILURE');
    } finally {
      await scenario.stop();
    }
  });
});
