import { testScenarioContext } from '../../mock-server/testing';
import { beforeAll, describe, it, expect } from 'vitest';
import { HttpStandardHeadersScenario } from './http-standard-headers';
import { finalizeChecks, rawChecksOf } from '../../hosted/session';
import { hostedScenarios } from '../../hosted/catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

/**
 * Negative test for SEP-2243 standard-header checks: a client that omits
 * Mcp-Method on a POST must produce a FAILURE row, and one that includes it
 * must produce SUCCESS. Pins the check id so coverage is tracked. The
 * carrier is tools/list, a 2026-07-28 request: the legacy initialize
 * handshake is not part of that revision and is not judged.
 */
describe('HttpStandardHeadersScenario (SEP-2243) — negative', () => {
  async function post(
    serverUrl: string,
    method: string,
    extraHeaders: Record<string, string>
  ): Promise<void> {
    const r = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders
      },
      body: JSON.stringify(
        method === 'initialize'
          ? {
              jsonrpc: '2.0',
              id: 1,
              method,
              params: {
                protocolVersion: '2025-11-25',
                clientInfo: { name: 'neg-test', version: '0' },
                capabilities: {}
              }
            }
          : { jsonrpc: '2.0', id: 1, method }
      )
    });
    await r.text();
  }

  // The coarse check id is emitted once per method/name case, so we narrow to
  // the tools/list Mcp-Method emission via its (case-specific) name.
  const COARSE_ID = 'sep-2243-client-includes-standard-headers';
  const LIST_METHOD_NAME = 'ClientMcpMethodHeader_tools_list';

  it('FAILs the tools/list Mcp-Method emission when Mcp-Method is missing', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(serverUrl, 'tools/list', {}); // no Mcp-Method header
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === COARSE_ID && c.name === LIST_METHOD_NAME
      );
      expect(check?.status).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  });

  it('SUCCEEDs the tools/list Mcp-Method emission when Mcp-Method matches', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(serverUrl, 'tools/list', { 'Mcp-Method': 'tools/list' });
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === COARSE_ID && c.name === LIST_METHOD_NAME
      );
      expect(check?.status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });

  it('does not judge the legacy initialize handshake', async () => {
    // A dual-era client may open with initialize to learn the server's era
    // (2026-07-28 basic/versioning, "Backward Compatibility"); Mcp-Method is a
    // 2026-07-28 header, so its absence there is not a finding.
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(serverUrl, 'initialize', {}); // no Mcp-Method header
      await post(serverUrl, 'notifications/initialized', {});
      expect(rawChecksOf(scenario)).toHaveLength(0);
      const names = scenario.getChecks().map((c) => c.name);
      expect(names).not.toContain('ClientMcpMethodHeader_initialize');
      expect(names).not.toContain(
        'ClientMcpMethodHeader_notifications_initialized'
      );
    } finally {
      await scenario.stop();
    }
  });

  it('getChecks() is idempotent', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await post(serverUrl, 'tools/list', { 'Mcp-Method': 'tools/list' });
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
        body: { jsonrpc: '2.0', id: 1, method: 'resources/list' },
        headers: { 'Mcp-Method': 'resources/list' }
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
        headers: { 'Mcp-Method': 'tools/list' } // a repeat adds no row
      }
    ]);
    expect(rawChecksOf(a).map((c) => c.name)).toEqual([
      'ClientMcpMethodHeader_resources_list'
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
    expect(byName.get('ClientMcpMethodHeader_resources_list')).toEqual([
      'SUCCESS'
    ]);
    expect(byName.get('ClientMcpMethodHeader_tools_list')).toEqual(['SUCCESS']);
    expect(byName.get('ClientMcpMethodHeader_tools_call')).toEqual(['SUCCESS']);
    expect(byName.get('ClientMcpNameHeader_tools_call')).toEqual(['FAILURE']);
    expect(byName.get('ClientMcpMethodHeader_prompts_get')).toEqual([
      'SKIPPED'
    ]);
    expect(judged).toHaveLength(6 + 3);
    // A log merged twice over (two processes that both saw resources/list)
    // still yields one row, the first recorded; judging leaves logs alone.
    const twice = finalizeChecks('http-standard-headers', [
      ...rawChecksOf(a),
      ...rawChecksOf(a)
    ]);
    expect(twice).toHaveLength(6 + 3);
    expect(rawChecksOf(a)).toHaveLength(1);
    expect(rawChecksOf(b)).toHaveLength(3);
  });
});

/**
 * Every request is judged, not only the first of each method: a client that
 * conforms at first and later sends a request without the header, from the
 * same connection or another, fails, and so does one that fails first and
 * conforms later. A conforming client adds one row per method however often
 * it calls it.
 */
describe('HttpStandardHeadersScenario (SEP-2243) — every request', () => {
  const LIST = 'ClientMcpMethodHeader_tools_list';

  async function drive(
    headersPerRequest: Record<string, string>[]
  ): Promise<HttpStandardHeadersScenario> {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      let id = 0;
      for (const headers of headersPerRequest) {
        const r = await fetch(serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++id,
            method: 'tools/list'
          })
        });
        await r.text();
      }
    } finally {
      await scenario.stop();
    }
    return scenario;
  }

  const statuses = (checks: { name: string; status: string }[]) =>
    checks.filter((c) => c.name === LIST).map((c) => c.status);

  it('fails a pass followed by a request without Mcp-Method on one connection', async () => {
    const s = await drive([{ 'Mcp-Method': 'tools/list' }, {}]);
    expect(statuses(rawChecksOf(s))).toEqual(['SUCCESS', 'FAILURE']);
    expect(statuses(s.getChecks())).toEqual(['FAILURE']);
  });

  it('fails a pass on one connection followed by a regression on another (merged log)', async () => {
    const first = await drive([{ 'Mcp-Method': 'tools/list' }]);
    const second = await drive([{}]);
    const judged = finalizeChecks('http-standard-headers', [
      ...rawChecksOf(first),
      ...rawChecksOf(second)
    ]);
    expect(statuses(judged)).toEqual(['FAILURE']);
    expect(judged.find((c) => c.name === LIST)?.errorMessage).toMatch(
      /Missing Mcp-Method header on tools\/list/
    );
  });

  it('still fails a regression followed by a pass, with both recorded', async () => {
    const s = await drive([{}, { 'Mcp-Method': 'tools/list' }]);
    expect(statuses(rawChecksOf(s))).toEqual(['FAILURE', 'SUCCESS']);
    expect(statuses(s.getChecks())).toEqual(['FAILURE']);
    const judged = finalizeChecks('http-standard-headers', rawChecksOf(s));
    expect(statuses(judged)).toEqual(['FAILURE']);
  });

  it('a conforming client that repeats a method keeps one SUCCESS row, as before', async () => {
    const s = await drive([
      { 'Mcp-Method': 'tools/list' },
      { 'Mcp-Method': 'tools/list' },
      { 'Mcp-Method': 'tools/list' }
    ]);
    expect(statuses(rawChecksOf(s))).toEqual(['SUCCESS']);
    expect(statuses(s.getChecks())).toEqual(['SUCCESS']);
    expect(s.getChecks()).toHaveLength(9);
  });
});
