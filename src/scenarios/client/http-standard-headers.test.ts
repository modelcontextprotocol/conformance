import { testScenarioContext } from '../../mock-server/testing';
import { describe, it, expect } from 'vitest';
import { HttpStandardHeadersScenario } from './http-standard-headers';
import { finalizeChecks, rawChecksOf } from '../../hosted/session';

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

  it('judges a merged log from two instances without SUCCESS and SKIPPED for one method', async () => {
    // The hosted server persists each process's raw log and judges the
    // merged log in a fresh instance (src/hosted/session.ts finalizeChecks):
    // a method one instance saw must not read as never sent in the re-judge.
    async function drive(
      requests: { body: object; headers: Record<string, string> }[]
    ): Promise<HttpStandardHeadersScenario> {
      const scenario = new HttpStandardHeadersScenario();
      const { serverUrl } = await scenario.start(testScenarioContext());
      try {
        for (const { body, headers } of requests) {
          const r = await fetch(serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
          });
          await r.text();
        }
      } finally {
        await scenario.stop();
      }
      return scenario;
    }
    const a = await drive([
      {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2026-07-28',
            clientInfo: { name: 'split', version: '0' },
            capabilities: {}
          }
        },
        headers: { 'Mcp-Method': 'initialize' }
      }
    ]);
    const b = await drive([
      {
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        headers: { 'Mcp-Method': 'tools/list' }
      },
      {
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'test_headers', arguments: {} }
        },
        headers: { 'Mcp-Method': 'tools/call' } // no Mcp-Name
      },
      {
        body: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
        headers: {} // second tools/list: the first already decided
      }
    ]);
    expect(rawChecksOf(a).map((c) => c.name)).toEqual([
      'ClientMcpMethodHeader_initialize'
    ]);
    expect(rawChecksOf(b).map((c) => c.name)).toEqual([
      'ClientMcpMethodHeader_tools_list',
      'ClientMcpMethodHeader_tools_call',
      'ClientMcpNameHeader_tools_call'
    ]);
    // Each instance alone skips what it never saw.
    expect(
      a.getChecks().find((c) => c.name === 'ClientMcpMethodHeader_tools_list')
        ?.status
    ).toBe('SKIPPED');

    const judged = finalizeChecks('http-standard-headers', [
      ...rawChecksOf(a),
      ...rawChecksOf(b)
    ]);
    const byName = new Map<string, string[]>();
    for (const c of judged)
      byName.set(c.name, [...(byName.get(c.name) ?? []), c.status]);
    // One row per method, never SUCCESS and SKIPPED for the same one.
    expect(byName.get('ClientMcpMethodHeader_initialize')).toEqual(['SUCCESS']);
    expect(byName.get('ClientMcpMethodHeader_tools_list')).toEqual(['SUCCESS']);
    expect(byName.get('ClientMcpMethodHeader_tools_call')).toEqual(['SUCCESS']);
    expect(byName.get('ClientMcpNameHeader_tools_call')).toEqual(['FAILURE']);
    expect(byName.get('ClientMcpMethodHeader_prompts_get')).toEqual([
      'SKIPPED'
    ]);
    expect(judged).toHaveLength(8 + 3);
    // A log merged twice over (two processes that both saw initialize)
    // still yields one row, the first recorded; judging leaves logs alone.
    const twice = finalizeChecks('http-standard-headers', [
      ...rawChecksOf(a),
      ...rawChecksOf(a)
    ]);
    expect(twice).toHaveLength(8 + 3);
    expect(rawChecksOf(a)).toHaveLength(1);
    expect(rawChecksOf(b)).toHaveLength(3);
  });
});
