import { testScenarioContext } from '../../mock-server/testing';
import { describe, it, expect } from 'vitest';
import {
  HttpCustomHeadersScenario,
  HttpInvalidToolHeadersScenario,
  CUSTOM_HEADERS_DECLARED_CHECK_IDS,
  INVALID_TOOL_DECLARED_CHECK_IDS
} from './http-custom-headers';
import { finalizeChecks, rawChecksOf } from '../../hosted/session';
import type { Step } from '../../steps';

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

  it('maps each parameter kind to its requirement ID on a conforming tool call', async () => {
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

  it('judges support for custom headers only on a call that carries an annotated argument', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    const call = (args: object, headers: Record<string, string> = {}) =>
      post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'test_custom_headers', arguments: args }
        },
        headers
      );
    try {
      // No arguments: nothing to mirror, so nothing about support either way.
      await call({});
      expect(
        statusesFor(
          rawChecksOf(scenario),
          'sep-2243-client-supports-custom-headers'
        )
      ).toEqual([]);
      // A later call with them, mirrored, shows it.
      await call(
        { region: 'us-west1', priority: 42 },
        { 'Mcp-Param-Region': 'us-west1', 'Mcp-Param-Priority': '42' }
      );
      const checks = scenario.getChecks();
      expect(
        statusesFor(checks, 'sep-2243-client-supports-custom-headers')
      ).toEqual(['SUCCESS']);
      expect(
        statusesFor(checks, 'sep-2243-client-mirrors-designated-params')
      ).not.toContain('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('still FAILs a call whose annotated arguments arrive without headers', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_custom_headers',
          arguments: { region: 'us-west1' }
        }
      });
      const checks = rawChecksOf(scenario);
      expect(
        statusesFor(checks, 'sep-2243-client-supports-custom-headers')
      ).toEqual(['FAILURE']);
      expect(
        statusesFor(checks, 'sep-2243-client-mirrors-designated-params')
      ).toContain('FAILURE');
      // Where it was judged: ahead of the per-parameter checks.
      expect(checks[0].id).toBe('sep-2243-client-supports-custom-headers');
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
});

describe('HttpInvalidToolHeadersScenario judged from its raw log', () => {
  it('FAILs the constraint when the tool was called in another process', async () => {
    // The hosted server judges a merged log in a fresh instance (see
    // src/hosted/session.ts finalizeChecks): what the observing instance
    // saw must be in its raw log, not in instance fields, or a tool the
    // client did call reads as never called.
    const observer = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await observer.start(testScenarioContext());
    try {
      await post(serverUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'invalid_number_header', arguments: { score: 1.5 } }
        },
        { 'Mcp-Param-Score': '1.5' }
      );
    } finally {
      await observer.stop();
    }
    const raw = rawChecksOf(observer);
    expect(raw.map((c) => c.id)).toEqual([
      'sep-2243-invalid-tool-tools-list-gate',
      'sep-2243-invalid-tool-call'
    ]);
    expect(raw[1].details).toMatchObject({
      tool: 'invalid_number_header',
      mcpParamHeaders: { 'mcp-param-score': '1.5' }
    });

    const judged = finalizeChecks('http-invalid-tool-headers', raw);
    expect(
      statusesFor(judged, 'sep-2243-x-mcp-header-primitive-only')
    ).toContain('FAILURE');
    expect(statusesFor(judged, 'sep-2243-client-reject-invalid-tool')).toEqual([
      'FAILURE'
    ]); // valid_tool never called
    expect(
      statusesFor(judged, 'sep-2243-invalid-tool-tools-list-gate')
    ).toEqual(['SUCCESS']);
    // Idempotent: judging leaves the raw log alone.
    expect(observer.getChecks()).toHaveLength(observer.getChecks().length);
    expect(rawChecksOf(observer)).toHaveLength(2);
  });
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

/** An Mcp-Param value per SEP-2243: plain when safe, else =?base64?…?=. */
function encodeParam(value: string | number | boolean): string {
  const s = String(value);
  const unsafe = /[^\x20-\x7e]/.test(s) || s !== s.trim();
  return unsafe
    ? `=?base64?${Buffer.from(s, 'utf-8').toString('base64')}?=`
    : s;
}

/**
 * A client with no handler for the scenario: it only follows the steps,
 * mirroring each x-mcp-header parameter from the schemas it listed.
 */
async function followSteps(
  serverUrl: string,
  steps: readonly Step[]
): Promise<void> {
  type Listed = {
    name: string;
    inputSchema: { properties?: Record<string, Record<string, unknown>> };
  };
  let tools: Listed[] = [];
  let id = 0;
  for (const step of steps) {
    if (step.op === 'tools/list') {
      const listed = await post(serverUrl, {
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/list'
      });
      tools = listed.body.result.tools;
    } else if (step.op === 'tools/call') {
      const props =
        tools.find((t) => t.name === step.name)?.inputSchema.properties ?? {};
      const headers: Record<string, string> = {
        'Mcp-Method': 'tools/call',
        'Mcp-Name': step.name
      };
      for (const [key, value] of Object.entries(step.arguments ?? {})) {
        const header = props[key]?.['x-mcp-header'];
        if (typeof header !== 'string' || value === null) continue;
        headers[`Mcp-Param-${header}`] = encodeParam(
          value as string | number | boolean
        );
      }
      await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name: step.name, arguments: step.arguments }
        },
        headers
      );
    }
  }
}

describe('custom-header scenarios steer a client with no handler for them', () => {
  it('http-custom-headers hands out one list of tool calls as toolCalls and as steps', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const urls = await scenario.start(testScenarioContext());
    try {
      const toolCalls = urls.context?.toolCalls as {
        name: string;
        arguments: Record<string, unknown>;
      }[];
      expect(toolCalls.map((c) => c.name)).toEqual([
        'test_custom_headers',
        'test_custom_headers_null'
      ]);
      expect(toolCalls[0].arguments).toMatchObject({
        non_ascii_val: 'Hello, 世界',
        crlf_val: 'line1\r\nline2',
        tab_val: '\tindented',
        leading_space_val: ' us-west1'
      });
      expect(toolCalls[1].arguments.verbose).toBeNull();
      expect(scenario.steps).toEqual([
        { op: 'tools/list' },
        ...toolCalls.map((c) => ({ op: 'tools/call', ...c }))
      ]);
    } finally {
      await scenario.stop();
    }
  });

  it('http-custom-headers: following the steps passes every declared check', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await followSteps(serverUrl, scenario.steps);
      const checks = scenario.getChecks();
      expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
      for (const id of CUSTOM_HEADERS_DECLARED_CHECK_IDS) {
        expect(statusesFor(checks, id), id).toContain('SUCCESS');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('http-invalid-tool-headers: following the steps calls valid_tool and passes', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      expect(scenario.steps).toEqual([
        { op: 'tools/list' },
        {
          op: 'tools/call',
          name: 'valid_tool',
          arguments: { region: 'us-west1' }
        }
      ]);
      await followSteps(serverUrl, scenario.steps);
      const checks = scenario.getChecks();
      expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
      expect(
        statusesFor(checks, 'sep-2243-client-reject-invalid-tool')
      ).toEqual(['SUCCESS']);
    } finally {
      await scenario.stop();
    }
  });
});
