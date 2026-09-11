import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHostedApp } from './server';
import { renderResults } from './html';
import { SessionManager, cellId } from './session';
import { MemoryRunStore } from './store';
import type { HostedMatrix } from './matrix';
import type { Server } from 'http';

const REV_STATEFUL = '2025-11-25';
const REV_STATELESS = '2026-07-28';

describe('hosted server', () => {
  let server: Server;
  let sessions: SessionManager;
  let matrix: HostedMatrix;
  let base: string;

  beforeAll(async () => {
    const hosted = createHostedApp({
      exclude: { 'sse-retry': 'excluded for the test' }
    });
    sessions = hosted.sessions;
    matrix = hosted.matrix;
    await new Promise<void>((resolve) => {
      server = hosted.app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object')
          base = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await sessions.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function postMcp(
    path: string,
    body: object,
    headers: Record<string, string> = {}
  ) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers
      },
      body: JSON.stringify(body)
    });
  }

  const initBody = (clientName = 'vitest') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: { name: clientName, version: '0' },
      capabilities: {}
    }
  });

  /** A SEP-2575 stateless request: version in the header and in _meta. */
  const statelessBody = (method: string, params: object = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
        'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  });
  const statelessHeaders = { 'mcp-protocol-version': REV_STATELESS };

  it('/scenarios lists every client scenario with a cell per revision', async () => {
    const list = await fetch(`${base}/scenarios`).then((r) => r.json());
    const byName = new Map<string, { cells: Record<string, unknown>[] }>(
      list.map((s: { name: string; cells: Record<string, unknown>[] }) => [
        s.name,
        s
      ])
    );
    expect(byName.has('initialize')).toBe(true);
    expect(byName.has('auth/basic-cimd')).toBe(true); // listed even though not startable
    const revisions = list[0].cells.map(
      (c: { revision: string }) => c.revision
    );
    expect(revisions).toEqual([REV_STATEFUL, REV_STATELESS]);
    // initialize was removed in 2026-07-28 → n/a there, scored before.
    expect(byName.get('initialize')!.cells).toEqual([
      { revision: REV_STATEFUL, scoring: 'scored', startable: true },
      {
        revision: REV_STATELESS,
        scoring: 'n/a',
        reason: 'introduced in 2025-06-18, removed in 2026-07-28',
        startable: false
      }
    ]);
    // auth cells need a relay origin this instance does not have.
    expect(byName.get('auth/basic-cimd')!.cells[0]).toMatchObject({
      scoring: 'scored',
      startable: false,
      startReason: 'needs relay origin(s) [as]'
    });
    // The deployment's exclusion list shows up with its reason.
    expect(byName.get('sse-retry')!.cells[0]).toMatchObject({
      startable: false,
      startReason: 'excluded for the test'
    });
  });

  it('mounts a raw-http scenario at /s/<run>/<rev>/<name> and records checks', async () => {
    const res = await postMcp(`/s/t1/${REV_STATEFUL}/initialize`, initBody());
    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toContain(
      `/results/t1/${REV_STATEFUL}/initialize>`
    );
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('test-server');

    const results = await fetch(
      `${base}/results/t1/${REV_STATEFUL}/initialize`
    ).then((r) => r.json());
    expect(results).toMatchObject({
      runId: 't1',
      revision: REV_STATEFUL,
      scenario: 'initialize'
    });
    expect(
      results.checks.some(
        (c: { id: string }) => c.id === 'mcp-client-initialization'
      )
    ).toBe(true);
  });

  it('mounts an express scenario, accumulating checks across stateless requests', async () => {
    // tools_call uses StreamableHTTPServerTransport with sessionIdGenerator: undefined,
    // i.e. fully stateless. Correlation must come from the path-embedded id.
    const url = `/s/t2/${REV_STATEFUL}/tools_call/mcp`;
    const r1 = await postMcp(url, initBody());
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 2, b: 3 } }
    });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('The sum of 2 and 3 is 5');

    const results = await fetch(
      `${base}/results/t2/${REV_STATEFUL}/tools_call`
    ).then((r) => r.json());
    expect(
      results.checks.some((c: { id: string }) => c.id === 'tool-add-numbers')
    ).toBe(true);
  });

  it('serves the stateful mock in the 2025-11-25 column and the stateless one in 2026-07-28', async () => {
    // Same scenario, two wires. The 2026-07-28 cell has no initialize
    // handshake and validates the SEP-2575 header/_meta on every request.
    const stateless = await postMcp(
      `/s/wire/${REV_STATELESS}/tools_call/mcp`,
      statelessBody('tools/call', {
        name: 'add_numbers',
        arguments: { a: 4, b: 6 }
      }),
      statelessHeaders
    );
    expect(stateless.status).toBe(200);
    expect(await stateless.text()).toContain('The sum of 4 and 6 is 10');

    // A stateful-style initialize (no header, no _meta) is rejected there…
    const rejected = await postMcp(
      `/s/wire/${REV_STATELESS}/tools_call/mcp`,
      initBody()
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe(-32020);

    // …and accepted by the 2025-11-25 cell of the same run.
    const stateful = await postMcp(
      `/s/wire/${REV_STATEFUL}/tools_call/mcp`,
      initBody()
    );
    expect(stateful.status).toBe(200);
    // The stateful mock answers initialize over SSE with the handshake result.
    const init = await stateful.text();
    expect(init).toContain('"serverInfo"');
    expect(init).toContain('"protocolVersion"');

    // Each cell judged independently.
    const a = await fetch(
      `${base}/results/wire/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    expect(
      a.checks.find((c: { id: string }) => c.id === 'tool-add-numbers')?.status
    ).toBe('SUCCESS');
    const b = await fetch(`${base}/results/wire`).then((r) => r.json());
    const exercised = (report: {
      columns: {
        cells: { revision: string; scenario: string; summary?: unknown }[];
      }[];
    }) =>
      report.columns.flatMap((col) =>
        col.cells.filter((c) => c.summary).map((c) => [c.revision, c.scenario])
      );
    expect(exercised(b)).toEqual([
      [REV_STATEFUL, 'tools_call'],
      [REV_STATELESS, 'tools_call']
    ]);
  });

  it('mounts a draft scenario (request-metadata) directly', async () => {
    // request-metadata simulates a version rejection on the *first* request to
    // exercise client retry, then accepts. Send twice — both with no
    // mcp-session-id (stateless) — and confirm checks accumulate via path id.
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 'DRAFT-2026-v1',
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    };
    const headers = { 'mcp-protocol-version': 'DRAFT-2026-v1' };
    const url = `/s/t3/${REV_STATELESS}/request-metadata`;
    const r1 = await postMcp(url, init, headers);
    expect(r1.status).toBe(400);
    // SEP-2575: unsupported-version rejection is -32022 (with supported/requested data).
    expect((await r1.json()).error.code).toBe(-32022);
    const r2 = await postMcp(url, init, headers);
    expect(r2.status).toBe(200);
    await r2.text();

    const results = await fetch(
      `${base}/results/t3/${REV_STATELESS}/request-metadata`
    ).then((r) => r.json());
    expect(results.scenario).toBe('request-metadata');
    expect(
      results.checks.some(
        (c: { id: string }) =>
          c.id === 'sep-2575-http-client-sends-version-header'
      )
    ).toBe(true);
  });

  it('json-schema-ref-deref embeds the public mounted URL in the canary $ref', async () => {
    const url = `/s/t4/${REV_STATELESS}/json-schema-ref-no-deref/mcp`;
    const r = await postMcp(url, statelessBody('tools/list'), statelessHeaders);
    const text = await r.text();
    // Canary URL should be the *mounted* base, not localhost:randomport
    expect(text).toContain(
      `${base}/s/t4/${REV_STATELESS}/json-schema-ref-no-deref/canary/profile-schema.json`
    );
  });

  it('GET /s mints a run id and redirects to its config', async () => {
    const res = await fetch(`${base}/s`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);
    const runId = location.slice('/s/'.length);

    const config = await fetch(`${base}${location}`).then((r) => r.json());
    expect(config.runId).toBe(runId);
    expect(config.revision).toBeUndefined();
    expect(config.resultsUrl).toBe(`${base}/results/${runId}`);
    // Every startable cell, keyed <rev>/<scenario>, none that cannot start.
    const keys = Object.keys(config.mcpServers);
    expect(keys).toContain(`${REV_STATEFUL}/tools_call`);
    expect(keys).toContain(`${REV_STATELESS}/tools_call`);
    expect(keys).toContain(`${REV_STATEFUL}/initialize`);
    expect(keys).not.toContain(`${REV_STATELESS}/initialize`); // n/a
    expect(keys.some((k) => k.endsWith('/auth/basic-cimd'))).toBe(false); // no relay
    expect(keys).not.toContain(`${REV_STATEFUL}/sse-retry`); // excluded
    expect(config.mcpServers[`${REV_STATEFUL}/tools_call`]).toEqual({
      type: 'http',
      url: `${base}/s/${runId}/${REV_STATEFUL}/tools_call/mcp`
    });
    const cell = config.cells.find(
      (c: { scenario: string; revision: string }) =>
        c.scenario === 'tools_call' && c.revision === REV_STATELESS
    );
    expect(cell).toMatchObject({
      url: `${base}/s/${runId}/${REV_STATELESS}/tools_call/mcp`,
      resultsUrl: `${base}/results/${runId}/${REV_STATELESS}/tools_call`,
      scoring: 'scored',
      env: {
        MCP_CONFORMANCE_SCENARIO: 'tools_call',
        MCP_CONFORMANCE_PROTOCOL_VERSION: REV_STATELESS
      }
    });
    expect(JSON.parse(cell.env.MCP_CONFORMANCE_CONTEXT)).toEqual({
      name: 'tools_call',
      steps: cell.steps
    });
    expect(cell.steps[0]).toEqual({ op: 'tools/list' });
  });

  it('scopes config to a column or a cell', async () => {
    const column = await fetch(`${base}/s/scope/${REV_STATELESS}`).then((r) =>
      r.json()
    );
    expect(column.revision).toBe(REV_STATELESS);
    expect(column.resultsUrl).toBe(`${base}/results/scope/${REV_STATELESS}`);
    expect(
      column.cells.every(
        (c: { revision: string }) => c.revision === REV_STATELESS
      )
    ).toBe(true);
    expect(
      column.cells.some(
        (c: { scenario: string }) => c.scenario === 'initialize'
      )
    ).toBe(false);

    const cell = await fetch(
      `${base}/s/scope/${REV_STATEFUL}/tools_call?format=json`
    ).then((r) => r.json());
    expect(cell).toMatchObject({
      runId: 'scope',
      revision: REV_STATEFUL,
      scenario: 'tools_call',
      resultsUrl: `${base}/results/scope/${REV_STATEFUL}/tools_call`
    });
    expect(cell.cells).toHaveLength(1);
    expect(Object.keys(cell.mcpServers)).toEqual([
      `${REV_STATEFUL}/tools_call`
    ]);
  });

  it('ignores a trailing slash on run, column and cell paths', async () => {
    const run = await fetch(`${base}/s/slash/`).then((r) => r.json());
    expect(run.runId).toBe('slash');
    expect(run.revision).toBeUndefined();

    const column = await fetch(`${base}/s/slash/${REV_STATEFUL}/`).then((r) =>
      r.json()
    );
    expect(column.revision).toBe(REV_STATEFUL);

    const cell = await fetch(
      `${base}/s/slash/${REV_STATEFUL}/tools_call/?format=json`
    ).then((r) => r.json());
    expect(cell.scenario).toBe('tools_call');
    expect(cell.cells).toHaveLength(1);

    for (const path of [
      `/results/slash/`,
      `/results/slash/${REV_STATEFUL}/`,
      `/results/slash/${REV_STATEFUL}/tools_call/`
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it('negotiates HTML for browsers, JSON otherwise, ?format= overriding both', async () => {
    const html = await fetch(`${base}/s/neg`, {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
    });
    expect(html.headers.get('content-type')).toContain('text/html');
    const json = await fetch(`${base}/s/neg`, {
      headers: { accept: '*/*' }
    });
    expect(json.headers.get('content-type')).toContain('application/json');
    const forcedJson = await fetch(`${base}/s/neg?format=json`, {
      headers: { accept: 'text/html' }
    });
    expect(forcedJson.headers.get('content-type')).toContain(
      'application/json'
    );
    const forcedHtml = await fetch(`${base}/s/neg?format=html`, {
      headers: { accept: 'application/json' }
    });
    expect(forcedHtml.headers.get('content-type')).toContain('text/html');
  });

  it('at a cell URL, a browser GET is a page and everything else reaches the scenario', async () => {
    const url = `${base}/s/dis/${REV_STATEFUL}/tools_call`;
    const page = await fetch(url, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('link')).toBeNull();

    // An SSE GET is the client under test; it reaches the scenario's mount
    // (whose root is not the MCP endpoint here) and carries the results link.
    const sse = await fetch(url, {
      headers: { accept: 'text/html, text/event-stream' }
    });
    expect(sse.status).toBe(404);
    expect(sse.headers.get('link')).toContain(
      `/results/dis/${REV_STATEFUL}/tools_call>`
    );
  });

  it('isolates cells with the same scenario but different run ids', async () => {
    await postMcp(`/s/iso-a/${REV_STATEFUL}/initialize`, initBody('a')).then(
      (r) => r.text()
    );
    await postMcp(`/s/iso-b/${REV_STATEFUL}/initialize`, initBody('b')).then(
      (r) => r.text()
    );

    const a = await fetch(
      `${base}/results/iso-a/${REV_STATEFUL}/initialize`
    ).then((r) => r.json());
    const b = await fetch(
      `${base}/results/iso-b/${REV_STATEFUL}/initialize`
    ).then((r) => r.json());
    expect(a.checks[0].details.clientName).toBe('a');
    expect(b.checks[0].details.clientName).toBe('b');
  });

  it('explains why a cell cannot be reached', async () => {
    const body = { jsonrpc: '2.0' };
    // unknown scenario
    let res = await postMcp(`/s/x/${REV_STATEFUL}/does-not-exist`, body);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(
      "unknown scenario 'does-not-exist'"
    );
    // bad run id / unknown revision
    res = await postMcp(`/s/bad..id/${REV_STATEFUL}/initialize`, body);
    expect(res.status).toBe(400);
    res = await postMcp('/s/x/2024-01-01/initialize', body);
    expect(res.status).toBe(404);
    expect((await res.json()).revisions).toEqual([REV_STATEFUL, REV_STATELESS]);
    // n/a: the scenario does not apply to the revision
    res = await postMcp(`/s/x/${REV_STATELESS}/initialize`, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      scoring: 'n/a',
      reason: 'introduced in 2025-06-18, removed in 2026-07-28'
    });
    // not converted for hosting yet
    res = await postMcp(`/s/x/${REV_STATEFUL}/auth/scope-step-up`, body);
    expect(res.status).toBe(501);
    expect((await res.json()).reason).toBe('not converted for hosting yet');
    // needs a relay origin
    res = await postMcp(`/s/x/${REV_STATEFUL}/auth/basic-cimd/mcp`, body);
    expect(res.status).toBe(501);
    expect((await res.json()).reason).toBe('needs relay origin(s) [as]');
    // excluded by the deployment
    res = await postMcp(`/s/x/${REV_STATEFUL}/sse-retry`, body);
    expect(res.status).toBe(501);
    expect((await res.json()).reason).toBe('excluded for the test');
    // the old shapes are gone
    res = await postMcp('/s/initialize/x', body);
    expect(res.status).toBe(404);
    res = await postMcp(`/s/x/${REV_STATEFUL}`, body);
    expect(res.status).toBe(405);
  });

  it('DELETE /results/<run-id> tears down every cell of the run', async () => {
    await postMcp(`/s/del/${REV_STATEFUL}/initialize`, initBody()).then((r) =>
      r.text()
    );
    await postMcp(
      `/s/del/${REV_STATELESS}/tools_call/mcp`,
      statelessBody('tools/list'),
      statelessHeaders
    ).then((r) => r.text());
    type Cell = {
      scenario: string;
      summary?: { total: number };
      resultsUrl: string;
    };
    const exercised = (report: { columns: { cells: Cell[] }[] }) =>
      report.columns.flatMap((col) => col.cells.filter((c) => c.summary));
    let run = await fetch(`${base}/results/del`).then((r) => r.json());
    expect(exercised(run)).toHaveLength(2);
    expect(exercised(run)[0]).toMatchObject({
      revision: REV_STATEFUL,
      scenario: 'initialize',
      verdict: 'pass',
      resultsUrl: `${base}/results/del/${REV_STATEFUL}/initialize`
    });
    expect(exercised(run)[0].summary!.total).toBeGreaterThan(0);

    const del = await fetch(`${base}/results/del`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    run = await fetch(`${base}/results/del`).then((r) => r.json());
    expect(exercised(run)).toEqual([]);
    expect(
      (await fetch(`${base}/results/del/${REV_STATEFUL}/initialize`)).status
    ).toBe(404);
  });

  it('records the client identity on both wires without eating the body', async () => {
    // Stateful: identity comes from the initialize params.
    await postMcp(`/s/who/${REV_STATEFUL}/tools_call/mcp`, initBody('sdk-a'), {
      'user-agent': 'vitest-agent/1'
    }).then((r) => r.text());
    // A later request on the same wire only carries the header; same client,
    // different protocolVersion → a second identity.
    await postMcp(
      `/s/who/${REV_STATEFUL}/tools_call/mcp`,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'add_numbers', arguments: { a: 1, b: 1 } }
      },
      { 'mcp-protocol-version': '2025-06-18', 'user-agent': 'vitest-agent/1' }
    ).then((r) => r.text());
    const stateful = await fetch(
      `${base}/results/who/${REV_STATEFUL}/tools_call`
    ).then((r) => r.json());
    const ids = stateful.checks.filter(
      (c: { id: string }) => c.id === 'hosted-client-identity'
    );
    expect(ids.map((c: { details: unknown }) => c.details)).toEqual([
      {
        name: 'sdk-a',
        version: '0',
        protocolVersion: '2025-06-18',
        userAgent: 'vitest-agent/1'
      },
      { protocolVersion: '2025-06-18', userAgent: 'vitest-agent/1' }
    ]);
    expect(ids[0].status).toBe('INFO');
    // The scenario still saw and judged the body it was going to read.
    expect(stateful.summary.passed).toBeGreaterThanOrEqual(1);
    expect(
      stateful.checks.find((c: { id: string }) => c.id === 'tool-add-numbers')
        ?.status
    ).toBe('SUCCESS');

    // Stateless: identity comes from _meta on every request.
    await postMcp(
      `/s/who/${REV_STATELESS}/tools_call/mcp`,
      statelessBody('tools/list'),
      { ...statelessHeaders, 'user-agent': 'vitest-agent/2' }
    ).then((r) => r.text());
    const stateless = await fetch(
      `${base}/results/who/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    expect(
      stateless.checks
        .filter((c: { id: string }) => c.id === 'hosted-client-identity')
        .map((c: { details: unknown }) => c.details)
    ).toEqual([
      {
        name: 'vitest',
        version: '0',
        protocolVersion: REV_STATELESS,
        userAgent: 'vitest-agent/2'
      }
    ]);
  });

  it('reports a verdict per cell with scored X of N per column', async () => {
    const run = 'rep';
    // pass
    await postMcp(
      `/s/${run}/${REV_STATEFUL}/initialize`,
      initBody('rep-client')
    ).then((r) => r.text());
    // fail: request-metadata's first request is rejected on purpose; stopping
    // there leaves its declared checks unemitted → FAILURE on judgement.
    await postMcp(
      `/s/${run}/${REV_STATELESS}/request-metadata`,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { 'mcp-protocol-version': 'DRAFT-2026-v1' }
    ).then((r) => r.text());
    // incomplete (created via config, never hit): every other startable cell.
    await fetch(`${base}/s/${run}`).then((r) => r.json());

    const report = await fetch(`${base}/results/${run}`).then((r) => r.json());
    expect(report.runId).toBe(run);
    expect(report.columns.map((c: { revision: string }) => c.revision)).toEqual(
      [REV_STATEFUL, REV_STATELESS]
    );
    const [stateful, stateless] = report.columns;
    const find = (col: { cells: { scenario: string }[] }, name: string) =>
      col.cells.find((c) => c.scenario === name) as Record<string, unknown>;
    expect(find(stateful, 'initialize')).toMatchObject({
      verdict: 'pass',
      scoring: 'scored',
      resultsUrl: `${base}/results/${run}/${REV_STATEFUL}/initialize`
    });
    expect(find(stateless, 'request-metadata').verdict).toBe('fail');
    expect(find(stateless, 'initialize').verdict).toBe('n/a');
    expect(find(stateful, 'tools_call').verdict).toBe('incomplete'); // configured, never hit
    expect(find(stateful, 'auth/basic-cimd')).toMatchObject({
      verdict: 'incomplete',
      startable: false
    });
    const scoredStartable = (rev: string) =>
      matrix
        .cells()
        .filter(
          (c) => c.revision === rev && c.scoring === 'scored' && c.startable
        ).length;
    expect(stateful.scored).toEqual({
      passed: 1,
      total: scoredStartable(REV_STATEFUL)
    });
    expect(stateless.scored).toEqual({
      passed: 0,
      total: scoredStartable(REV_STATELESS)
    });
    // Header shows who talked to the run: the stateful client by name, and
    // the header-only probe that hit request-metadata.
    expect(report.identities).toContainEqual(
      expect.objectContaining({
        name: 'rep-client',
        protocolVersion: '2025-06-18'
      })
    );
    expect(stateful.identities).toEqual([
      expect.objectContaining({ name: 'rep-client' })
    ]);
    expect(stateless.identities).toEqual([
      expect.objectContaining({ protocolVersion: 'DRAFT-2026-v1' })
    ]);

    // Column scope and HTML.
    const column = await fetch(`${base}/results/${run}/${REV_STATELESS}`).then(
      (r) => r.json()
    );
    expect(column.revision).toBe(REV_STATELESS);
    expect(column.columns).toHaveLength(1);
    const html = await fetch(`${base}/results/${run}`, {
      headers: { accept: 'text/html' }
    });
    expect(html.headers.get('content-type')).toContain('text/html');
    const text = await html.text();
    expect(text).toContain(`scored 1 of ${scoredStartable(REV_STATEFUL)}`);
    expect(text).toContain('<b>rep-client</b>');
    expect(text).toContain('>fail</span>');
    expect(text).toContain(
      `href="${base}/results/${run}/${REV_STATEFUL}/initialize"`
    );
  });

  it('fails a cell when the wire rejects the request or the client speaks another revision', async () => {
    // Felix's live case: a 2025-11-25 initialize on a 2026-07-28 cell. The
    // stateless mock turns it away (no _meta) and the scenario never sees a
    // request it could judge — the cell must read fail, not green.
    const url = `/s/rej/${REV_STATELESS}/tools_call/mcp`;
    const legacyInit = {
      ...initBody(),
      params: { ...initBody().params, protocolVersion: REV_STATEFUL }
    };
    for (let i = 0; i < 2; i++) {
      const r = await postMcp(url, legacyInit, {
        'mcp-protocol-version': REV_STATEFUL
      });
      expect(r.status).toBe(400);
      await r.text();
    }
    // …and one with no header at all (the -32020 rejection).
    const bare = await postMcp(url, initBody());
    expect(bare.status).toBe(400);
    await bare.text();

    const results = await fetch(
      `${base}/results/rej/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    type Check = {
      id: string;
      status: string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    };
    const rejected = results.checks.filter(
      (c: Check) => c.id === 'hosted-wire-rejected'
    );
    // Once per distinct (code, message): the repeated -32602 is one check.
    expect(rejected.map((c: Check) => c.details?.code)).toEqual([
      -32602, -32020
    ]);
    expect(rejected[0]).toMatchObject({
      status: 'FAILURE',
      details: {
        status: 400,
        method: 'initialize',
        requestedVersion: REV_STATEFUL
      }
    });
    expect(rejected[1].details).toMatchObject({
      code: -32020,
      requestedVersion: '2025-06-18' // no header: the body's version
    });
    const wrong = results.checks.filter(
      (c: Check) => c.id === 'hosted-wrong-revision'
    );
    // Once per distinct (method, header version).
    expect(wrong.map((c: Check) => c.errorMessage)).toEqual([
      `cell is served on ${REV_STATELESS}; client sent initialize`,
      `cell is served on ${REV_STATELESS}; client sent initialize`
    ]);
    expect(wrong.map((c: Check) => c.details?.headerVersion)).toEqual([
      REV_STATEFUL,
      null
    ]);
    const report = await fetch(`${base}/results/rej`).then((r) => r.json());
    const cellOf = (rev: string, name: string) =>
      report.columns
        .find((c: { revision: string }) => c.revision === rev)
        .cells.find((c: { scenario: string }) => c.scenario === name);
    expect(cellOf(REV_STATELESS, 'tools_call').verdict).toBe('fail');

    // On a dated revision initialize negotiates freely, but every later
    // request must name the cell's revision in its header.
    const stateful = `/s/rej/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(stateful, initBody()).then((r) => r.text());
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 1, b: 2 } }
    };
    await postMcp(stateful, call, {
      'mcp-protocol-version': '2025-06-18'
    }).then((r) => r.text());
    const b = await fetch(
      `${base}/results/rej/${REV_STATEFUL}/tools_call`
    ).then((r) => r.json());
    expect(
      b.checks.find((c: Check) => c.id === 'tool-add-numbers').status
    ).toBe('SUCCESS');
    expect(
      b.checks
        .filter((c: Check) => c.id === 'hosted-wrong-revision')
        .map((c: Check) => c.errorMessage)
    ).toEqual([`cell is served on ${REV_STATEFUL}; client sent 2025-06-18`]);
    expect(b.checks.some((c: Check) => c.id === 'hosted-wire-rejected')).toBe(
      false
    );
    // The scenario passed; the hosted FAILURE still decides the verdict.
    expect(cellOf(REV_STATEFUL, 'tools_call')).toBeDefined();
    const report2 = await fetch(`${base}/results/rej`).then((r) => r.json());
    expect(
      report2.columns[0].cells.find(
        (c: { scenario: string }) => c.scenario === 'tools_call'
      ).verdict
    ).toBe('fail');

    // A client that speaks the cell's revision records neither check, and a
    // non-MCP path under the cell (the canary) is never judged.
    const ok = `/s/rej/${REV_STATELESS}/json-schema-ref-no-deref/mcp`;
    await postMcp(ok, statelessBody('tools/list'), statelessHeaders).then((r) =>
      r.text()
    );
    await fetch(
      `${base}/s/rej/${REV_STATELESS}/json-schema-ref-no-deref/canary/profile-schema.json`
    ).then((r) => r.text());
    const clean = await fetch(
      `${base}/results/rej/${REV_STATELESS}/json-schema-ref-no-deref`
    ).then((r) => r.json());
    expect(
      clean.checks.filter((c: Check) => c.id.startsWith('hosted-w'))
    ).toEqual([]);
  });

  it('HTML-escapes the run id in the results report', () => {
    const html = renderResults(
      {
        runId: '"><script>x</script>',
        revision: REV_STATEFUL,
        scenarioName: 'initialize'
      },
      []
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
  });

  it('every startable cell can be instantiated without binding a port', () => {
    // Guard against regressions where a handler() implementation reaches for
    // this._server / this.port etc., and against per-run instances that lose
    // constructor parameters (one class registered under several names must
    // implement fresh()).
    const startable = matrix.cells().filter((c) => c.startable);
    expect(startable.length).toBeGreaterThanOrEqual(10);
    for (const c of startable) {
      const ref = {
        runId: 'probe',
        revision: c.revision,
        scenarioName: c.scenario
      };
      const run = sessions.getOrCreate(ref, () => 'http://x');
      expect(typeof run.listener).toBe('function');
      expect(run.scenario.name).toBe(c.scenario);
      expect(run.id).toBe(cellId(ref));
    }
  });
});

describe('hosted server across processes (shared store)', () => {
  // Two apps over one store stand in for two serverless isolates that
  // load-balance a run's requests.
  const store = new MemoryRunStore();
  const apps = [createHostedApp({ store }), createHostedApp({ store })];
  const servers: Server[] = [];
  const origins: string[] = [];

  beforeAll(async () => {
    for (const { app } of apps) {
      await new Promise<void>((resolve) => {
        const s = app.listen(0, () => {
          servers.push(s);
          const addr = s.address() as { port: number };
          origins.push(`http://localhost:${addr.port}`);
          resolve();
        });
      });
    }
  });

  afterAll(async () => {
    for (const { sessions } of apps) await sessions.close();
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r())))
    );
  });

  it("rejects request-metadata's first request once per run, not once per process", async () => {
    const path = `/s/split/${REV_STATELESS}/request-metadata/mcp`;
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
          'io.modelcontextprotocol/clientInfo': {
            name: 'vitest',
            version: '0'
          },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    };
    const send = (origin: string) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': REV_STATELESS
        },
        body: JSON.stringify(body)
      });

    const first = await send(origins[0]);
    expect(first.status).toBe(400);
    expect((await first.json()).error.code).toBe(-32022);
    await apps[0].sessions.flush();

    // The retry lands on the other process, which has never seen the cell.
    const second = await send(origins[1]);
    expect(second.status).toBe(200);
    await second.text();
    await apps[1].sessions.flush();

    for (const origin of origins) {
      const results = await fetch(
        `${origin}/results/split/${REV_STATELESS}/request-metadata`
      ).then((r) => r.json());
      const retries = results.checks.filter(
        (c: { id: string }) =>
          c.id === 'sep-2575-client-retry-supported-version'
      );
      expect(retries).toHaveLength(1);
      expect(retries[0].status).toBe('SUCCESS');
      expect(
        results.checks.filter((c: { status: string }) => c.status === 'FAILURE')
      ).toEqual([]);
      const report = await fetch(`${origin}/results/split`).then((r) =>
        r.json()
      );
      expect(
        report.columns[1].cells.find(
          (c: { scenario: string }) => c.scenario === 'request-metadata'
        ).verdict
      ).toBe('pass');
    }
  });
});
