import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHostedApp } from './server';
import { renderResults } from './html';
import { SessionManager, cellId, rawChecksOf } from './session';
import { MemoryRunStore } from './store';
import type { HostedMatrix } from './matrix';
import type { Server } from 'http';
import { takeWireViolations } from '../validation/wire-schema';

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

  const initBody = (clientName = 'vitest', protocolVersion = '2025-06-18') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
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
      startReason:
        'needs a separate sign-in server, which this deployment is not set up with'
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

    // A stateful-style initialize (no header, no _meta) is turned away there,
    // with the unsupported-version error naming the version it does serve…
    const rejected = await postMcp(
      `/s/wire/${REV_STATELESS}/tools_call/mcp`,
      initBody()
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toMatchObject({
      code: -32022,
      data: { supported: [REV_STATELESS] }
    });

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
    const url = `/s/t3/${REV_STATELESS}/request-metadata`;
    const r1 = await postMcp(
      url,
      statelessBody('tools/list'),
      statelessHeaders
    );
    expect(r1.status).toBe(400);
    // SEP-2575: unsupported-version rejection is -32022 (with supported/requested data).
    expect((await r1.json()).error.code).toBe(-32022);
    const r2 = await postMcp(
      url,
      statelessBody('tools/list'),
      statelessHeaders
    );
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
    // The scenario rewrites the draft header to the SDK's before handing
    // the request on; identity is read from the header the client sent.
    const results = await fetch(
      `${base}/results/t4/${REV_STATELESS}/json-schema-ref-no-deref`
    ).then((r) => r.json());
    const identity = results.checks.find(
      (c: { id: string }) => c.id === 'hosted-client-identity'
    );
    expect(identity.details).toMatchObject({
      name: 'vitest',
      protocolVersions: [REV_STATELESS]
    });
  });

  it('GET /s mints a run id and redirects to its config', async () => {
    const res = await fetch(`${base}/s`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    const location = res.headers.get('location')!;
    // Crockford base32, lower case: no i, l, o or u to misread.
    expect(location).toMatch(/^\/s\/[0-9a-hjkmnp-tv-z]{10}$/);
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

  it('hands the header scenarios their tool calls and steps, as the CLI runner does', async () => {
    const cellOf = async (scenario: string) =>
      (
        await fetch(
          `${base}/s/hdr/${REV_STATELESS}/${scenario}?format=json`
        ).then((r) => r.json())
      ).cells[0];

    const custom = await cellOf('http-custom-headers');
    const context = JSON.parse(custom.env.MCP_CONFORMANCE_CONTEXT);
    expect(context.name).toBe('http-custom-headers');
    expect(context.toolCalls.map((c: { name: string }) => c.name)).toEqual([
      'test_custom_headers',
      'test_custom_headers_null'
    ]);
    expect(context.toolCalls[0].arguments.crlf_val).toBe('line1\r\nline2');
    expect(context.steps).toEqual(custom.steps);
    expect(
      custom.steps.map((s: { op: string; name?: string }) => s.name ?? s.op)
    ).toEqual([
      'tools/list',
      'test_custom_headers',
      'test_custom_headers_null'
    ]);

    const invalid = await cellOf('http-invalid-tool-headers');
    expect(invalid.steps).toEqual([
      { op: 'tools/list' },
      {
        op: 'tools/call',
        name: 'valid_tool',
        arguments: { region: 'us-west1' }
      }
    ]);
    expect(JSON.parse(invalid.env.MCP_CONFORMANCE_CONTEXT)).toEqual({
      name: 'http-invalid-tool-headers',
      steps: invalid.steps
    });
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

    // An SSE GET is the client under test; it reaches the scenario, which
    // serves no stream on its MCP endpoint (405, not Express's HTML 404),
    // and carries the results link.
    const sse = await fetch(url, {
      headers: { accept: 'text/html, text/event-stream' }
    });
    expect(sse.status).toBe(405);
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
    // not available hosted yet
    res = await postMcp(`/s/x/${REV_STATEFUL}/auth/dpop`, body);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: `scenario 'auth/dpop' at ${REV_STATEFUL} cannot be started here: not available on the hosted server yet; run it with the conformance CLI`,
      reason:
        'not available on the hosted server yet; run it with the conformance CLI'
    });
    // needs a relay origin
    res = await postMcp(`/s/x/${REV_STATEFUL}/auth/basic-cimd/mcp`, body);
    expect(res.status).toBe(501);
    expect((await res.json()).reason).toBe(
      'needs a separate sign-in server, which this deployment is not set up with'
    );
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
    await postMcp(
      `/s/del/${REV_STATEFUL}/initialize`,
      initBody('vitest', REV_STATEFUL)
    ).then((r) => r.text());
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
    // The cell is still a cell of the matrix — just nothing recorded now.
    const gone = await fetch(`${base}/results/del/${REV_STATEFUL}/initialize`);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({
      verdict: 'incomplete',
      summary: { total: 0 },
      checks: []
    });
  });

  it('serves every cell at <cell>/mcp, whatever the scenario mounts at its root', async () => {
    // request-metadata and initialize serve MCP at their handler root; the
    // config still says /mcp, and a request there is rewritten to the root.
    const config = await fetch(
      `${base}/s/mcp1/${REV_STATELESS}/request-metadata?format=json`
    ).then((r) => r.json());
    expect(config.cells[0].url).toBe(
      `${base}/s/mcp1/${REV_STATELESS}/request-metadata/mcp`
    );
    const run = await fetch(`${base}/s/mcp1`).then((r) => r.json());
    const urls = Object.values(run.mcpServers).map(
      (s) => (s as { url: string }).url
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith('/mcp'))).toBe(true);
    const list = await fetch(`${base}/scenarios`).then((r) => r.json());
    expect(list.every((s: { mcpPath: string }) => s.mcpPath === '/mcp')).toBe(
      true
    );

    // Reaches the scenario: request-metadata answers its simulated
    // rejection, initialize its handshake — not a 404.
    const rm = await postMcp(
      `/s/mcp1/${REV_STATELESS}/request-metadata/mcp`,
      statelessBody('tools/list'),
      statelessHeaders
    );
    expect(rm.status).toBe(400);
    expect((await rm.json()).error.code).toBe(-32022);
    const init = await postMcp(
      `/s/mcp1/${REV_STATEFUL}/initialize/mcp`,
      initBody()
    );
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe('test-server');
    // A scenario with its own /mcp is served as before, and the bare cell
    // root of a root-mounted scenario still answers (the CLI's shape).
    const own = await postMcp(
      `/s/mcp1/${REV_STATEFUL}/tools_call/mcp`,
      initBody()
    );
    expect(own.status).toBe(200);
    await own.text();
    const root = await postMcp(
      `/s/mcp1/${REV_STATEFUL}/initialize`,
      initBody()
    );
    expect(root.status).toBe(200);
    await root.text();

    // The -32022 request-metadata answered above was its own probe of a
    // client that named the cell's revision — not a wire rejection.
    const probed = await fetch(
      `${base}/results/mcp1/${REV_STATELESS}/request-metadata`
    ).then((r) => r.json());
    expect(
      probed.checks.some((c: { id: string }) => c.id === 'hosted-wire-rejected')
    ).toBe(false);

    // <cell>/mcp on a root-mounted scenario is its MCP endpoint for the
    // hosted judgement too: a stateful initialize there is a legacy probe.
    await postMcp(
      `/s/mcp1/${REV_STATELESS}/request-metadata/mcp`,
      initBody()
    ).then((r) => r.text());
    const judged = await fetch(
      `${base}/results/mcp1/${REV_STATELESS}/request-metadata`
    ).then((r) => r.json());
    expect(
      judged.checks.some((c: { id: string }) => c.id === 'hosted-legacy-probe')
    ).toBe(true);
  });

  it('answers results for every cell of the matrix, exercised or not', async () => {
    const zeros = {
      passed: 0,
      failed: 0,
      notSeen: 0,
      warnings: 0,
      info: 0,
      skipped: 0,
      total: 0
    };
    // Untouched, startable: a valid, incomplete cell — not an unknown run.
    const fresh = await fetch(
      `${base}/results/fresh/${REV_STATEFUL}/tools_call`
    );
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({
      runId: 'fresh',
      revision: REV_STATEFUL,
      scenario: 'tools_call',
      scoring: 'scored',
      verdict: 'incomplete',
      state: 'not-tried',
      note: 'nothing recorded yet — point the client at the MCP endpoint',
      summary: zeros,
      checks: []
    });
    // n/a: the scenario does not apply to the revision.
    const na = await fetch(`${base}/results/fresh/${REV_STATELESS}/initialize`);
    expect(na.status).toBe(200);
    expect(await na.json()).toMatchObject({
      scoring: 'n/a',
      verdict: 'n/a',
      reason: 'introduced in 2025-06-18, removed in 2026-07-28',
      summary: zeros,
      checks: []
    });
    // Not startable here.
    expect(
      await fetch(`${base}/results/fresh/${REV_STATEFUL}/auth/basic-cimd`).then(
        (r) => r.json()
      )
    ).toMatchObject({
      scoring: 'scored',
      verdict: 'incomplete',
      startable: false,
      startReason:
        'needs a separate sign-in server, which this deployment is not set up with'
    });
    expect(
      await fetch(`${base}/results/fresh/${REV_STATEFUL}/sse-retry`).then((r) =>
        r.json()
      )
    ).toMatchObject({ startable: false, startReason: 'excluded for the test' });
    // An exercised cell says where it stands too.
    await postMcp(
      `/s/fresh/${REV_STATEFUL}/initialize/mcp`,
      initBody('vitest', REV_STATEFUL)
    ).then((r) => r.text());
    expect(
      await fetch(`${base}/results/fresh/${REV_STATEFUL}/initialize`).then(
        (r) => r.json()
      )
    ).toMatchObject({ scoring: 'scored', verdict: 'pass' });

    // HTML equivalents carry the reason text.
    const page = (path: string) =>
      fetch(`${base}${path}`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text()
      );
    expect(await page(`/results/fresh/${REV_STATEFUL}/tools_call`)).toContain(
      'nothing recorded yet'
    );
    expect(await page(`/results/fresh/${REV_STATELESS}/initialize`)).toContain(
      'does not apply to this revision: introduced in 2025-06-18, removed in 2026-07-28'
    );
    expect(
      await page(`/results/fresh/${REV_STATEFUL}/auth/basic-cimd`)
    ).toContain(
      'not startable here: needs a separate sign-in server, which this deployment is not set up with'
    );

    // Only an unknown revision or scenario is a 404.
    expect(
      (await fetch(`${base}/results/fresh/2024-01-01/tools_call`)).status
    ).toBe(404);
    expect(
      (await fetch(`${base}/results/fresh/${REV_STATEFUL}/no-such`)).status
    ).toBe(404);
  });

  it('records the client identity on both wires without eating the body', async () => {
    // Stateful: name from the initialize params, version from what the
    // server answered over SSE — on a hosted dated cell always the cell's
    // revision, whatever the client asked for (a supported older version,
    // or one nobody knows). A second initialize by the same client adds to
    // the one identity; a later header-only request adds nothing.
    const url = `/s/who/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(url, initBody('sdk-a'), {
      'user-agent': 'vitest-agent/1'
    }).then((r) => r.text());
    await postMcp(
      url,
      {
        ...initBody('sdk-a'),
        params: { ...initBody('sdk-a').params, protocolVersion: 'bogus' }
      },
      { 'user-agent': 'vitest-agent/1' }
    ).then((r) => r.text());
    await postMcp(
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'add_numbers', arguments: { a: 1, b: 1 } }
      },
      { 'mcp-protocol-version': REV_STATEFUL, 'user-agent': 'vitest-agent/1' }
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
        protocolVersions: [REV_STATEFUL],
        userAgent: 'vitest-agent/1'
      }
    ]);
    expect(ids[0].status).toBe('INFO');
    expect(ids[0].description).toContain(
      `sdk-a 0 speaking protocol ${REV_STATEFUL}`
    );
    // The scenario still saw and judged the body it was going to read.
    expect(stateful.summary.passed).toBeGreaterThanOrEqual(1);
    expect(
      stateful.checks.find((c: { id: string }) => c.id === 'tool-add-numbers')
        ?.status
    ).toBe('SUCCESS');

    // Stateless: identity comes from _meta on every accepted request. One
    // the mock turns away (header disagreeing with _meta) is no identity.
    await postMcp(
      `/s/who/${REV_STATELESS}/tools_call/mcp`,
      statelessBody('tools/list'),
      { ...statelessHeaders, 'user-agent': 'vitest-agent/2' }
    ).then((r) => r.text());
    const rejected = await postMcp(
      `/s/who/${REV_STATELESS}/tools_call/mcp`,
      {
        ...statelessBody('tools/list'),
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
            'io.modelcontextprotocol/clientInfo': {
              name: 'nobody',
              version: '1'
            },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      },
      { 'mcp-protocol-version': REV_STATEFUL }
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
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
        protocolVersions: [REV_STATELESS],
        userAgent: 'vitest-agent/2'
      }
    ]);
  });

  it('reports a verdict per cell with scored X of N per column', async () => {
    const run = 'rep';
    // pass
    await postMcp(
      `/s/${run}/${REV_STATEFUL}/initialize`,
      initBody('rep-client', REV_STATEFUL)
    ).then((r) => r.text());
    // fail: request-metadata judges the _meta of every 2026-07-28 request,
    // and this one carries none → FAILURE on judgement.
    await postMcp(
      `/s/${run}/${REV_STATELESS}/request-metadata`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      statelessHeaders
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
    // N is the requirement set's count of scored cells (auth/* included,
    // though not startable without a relay); the startable subset alongside.
    const scoredCells = (rev: string) =>
      matrix
        .cells()
        .filter((c) => c.revision === rev && c.scoring === 'scored');
    const scoredOf = (rev: string, passed: number) => ({
      passed,
      total: scoredCells(rev).length,
      startable: scoredCells(rev).filter((c) => c.startable).length
    });
    expect(stateful.scored).toEqual(scoredOf(REV_STATEFUL, 1));
    expect(stateless.scored).toEqual(scoredOf(REV_STATELESS, 0));
    expect(stateful.scored.startable).toBeLessThan(stateful.scored.total);
    // Header shows who talked to the run: the stateful client by name; the
    // probe request-metadata turned away is no identity.
    expect(report.identities).toEqual([
      expect.objectContaining({
        name: 'rep-client',
        protocolVersions: [REV_STATEFUL]
      })
    ]);
    expect(stateful.identities).toEqual([
      expect.objectContaining({ name: 'rep-client' })
    ]);
    expect(stateless.identities).toEqual([]);

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
    expect(text).toContain(
      `1 of ${stateful.scored.total} scored (${stateful.scored.startable} startable here)`
    );
    expect(text).toContain('no client seen yet'); // the 2026-07-28 column
    expect(text).toContain('<b>rep-client</b>');
    expect(text).toContain('>fail</span>');
    expect(text).toContain(
      `href="${base}/results/${run}/${REV_STATEFUL}/initialize"`
    );
  });

  it('notes a legacy initialize on the stateless wire, and fails other wrong revisions', async () => {
    // Felix's live case: a 2025-11-25 initialize on a 2026-07-28 cell. The
    // stateless mock answers it the way a modern-only server should, with
    // -32022 naming the version it supports. A dual-era client may open that
    // way to learn the server's era (2026-07-28 basic/versioning, "Backward
    // Compatibility"), so it is noted, not failed; and as the scenario never
    // saw a request it could judge, the cell reads incomplete, never green.
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
      expect((await r.json()).error).toMatchObject({
        code: -32022,
        data: { supported: [REV_STATELESS], requested: REV_STATEFUL }
      });
    }
    // …and one with no header at all: still the same answer, since an
    // initialize is answered before its header is looked at.
    const bare = await postMcp(url, initBody());
    expect(bare.status).toBe(400);
    expect((await bare.json()).error.code).toBe(-32022);

    const results = await fetch(
      `${base}/results/rej/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    type Check = {
      id: string;
      status: string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    };
    // Neither a wrong revision nor a wire rejection: the probe explains both.
    expect(
      results.checks.some(
        (c: Check) =>
          c.id === 'hosted-wire-rejected' || c.id === 'hosted-wrong-revision'
      )
    ).toBe(false);
    const probes = results.checks.filter(
      (c: Check) => c.id === 'hosted-legacy-probe'
    );
    // Once per distinct header version: the repeat is one check.
    expect(
      probes.map((c: Check) => [
        c.status,
        c.details?.headerVersion,
        (c.details?.rejected as { code?: number } | undefined)?.code
      ])
    ).toEqual([
      ['INFO', REV_STATEFUL, -32022],
      ['INFO', null, -32022]
    ]);
    const report = await fetch(`${base}/results/rej`).then((r) => r.json());
    const cellOf = (rev: string, name: string) =>
      report.columns
        .find((c: { revision: string }) => c.revision === rev)
        .cells.find((c: { scenario: string }) => c.scenario === name);
    expect(cellOf(REV_STATELESS, 'tools_call').verdict).toBe('incomplete');

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

  it('answers a legacy initialize identically on every 2026-07-28 cell', async () => {
    // json-schema-ref-no-deref's bundled SDK server completes a legacy
    // handshake (the CLI's SDK clients rely on that), after which the cell
    // would fail the client for following it. The hosted layer answers first,
    // so the whole column says the same thing.
    type Check = {
      id: string;
      status: string;
      details?: Record<string, unknown>;
    };
    const legacyInit = {
      ...initBody(),
      params: { ...initBody().params, protocolVersion: REV_STATEFUL }
    };
    const expected = {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: [REV_STATELESS], requested: REV_STATEFUL }
      }
    };
    const cells = matrix
      .cells()
      .filter((c) => c.revision === REV_STATELESS && c.startable)
      .map((c) => c.scenario);
    expect(cells).toContain('json-schema-ref-no-deref');
    for (const name of cells) {
      const r = await postMcp(
        `/s/legacy/${REV_STATELESS}/${name}/mcp`,
        legacyInit,
        { 'mcp-protocol-version': REV_STATEFUL }
      );
      expect(r.status, name).toBe(400);
      expect(await r.json(), name).toEqual(expected);
    }

    // The client then speaks 2026-07-28 on the cell that used to accept the
    // handshake: judged on that, with the probe noted and nothing failed.
    const url = `/s/legacy/${REV_STATELESS}/json-schema-ref-no-deref/mcp`;
    const listed = await postMcp(
      url,
      statelessBody('tools/list'),
      statelessHeaders
    );
    expect(listed.status).toBe(200);
    await listed.text();
    const results = await fetch(
      `${base}/results/legacy/${REV_STATELESS}/json-schema-ref-no-deref`
    ).then((r) => r.json());
    const probe = results.checks.find(
      (c: Check) => c.id === 'hosted-legacy-probe'
    );
    expect(probe).toMatchObject({
      status: 'INFO',
      details: {
        headerVersion: REV_STATEFUL,
        requestedVersion: REV_STATEFUL,
        rejected: { status: 400, code: -32022 }
      }
    });
    expect(results.checks.filter((c: Check) => c.status === 'FAILURE')).toEqual(
      []
    );
    expect(results.verdict).toBe('pass');
  });

  it('reads a cell whose flow is waiting on a person as waiting, not failed', async () => {
    // MRTR right after the client connected: its tools listed, none called
    // yet. In progress, saying what it waits for, on the cell page too.
    const mcp = `/s/wait/${REV_STATELESS}/sep-2322-client-request-state/mcp`;
    const res = await postMcp(mcp, statelessBody('tools/list'), {
      ...statelessHeaders,
      'mcp-method': 'tools/list'
    });
    expect(res.status).toBe(200);
    await res.text();
    const cell = `/results/wait/${REV_STATELESS}/sep-2322-client-request-state`;
    const listed = await fetch(`${base}${cell}`).then((r) => r.json());
    expect(listed).toMatchObject({ state: 'in-progress' });
    expect(listed.note).toMatch(/the 5 failures listed are what it is still/);
    // The client called the tool and its elicitation form is open: the
    // server has answered with input_required and waits for the answer.
    const call = await postMcp(
      mcp,
      statelessBody('tools/call', { name: 'test_mrtr_echo_state' }),
      {
        ...statelessHeaders,
        'mcp-method': 'tools/call',
        'mcp-name': 'test_mrtr_echo_state'
      }
    );
    expect(call.status).toBe(200);
    expect(await call.text()).toContain('input_required');
    const json = await fetch(`${base}${cell}`).then((r) => r.json());
    // Nothing the client did failed: the verdict is incomplete, not fail,
    // and each row says it is not seen.
    expect(json).toMatchObject({
      verdict: 'incomplete',
      state: 'waiting',
      note: 'waiting for the client or the person to finish the flow',
      summary: { failed: 0, notSeen: 5 }
    });
    // Its rows read NOT_SEEN (and keep notSeen), never FAILURE, so counting
    // them by status gives the summary.
    const rows = json.checks as { status: string; notSeen?: boolean }[];
    expect(rows.filter((c) => c.status === 'FAILURE')).toEqual([]);
    const unmet = rows.filter((c) => c.status === 'NOT_SEEN');
    expect(unmet).toHaveLength(5);
    expect(unmet.every((c) => c.notSeen === true)).toBe(true);
    const page = await fetch(`${base}${cell}`, {
      headers: { accept: 'text/html' }
    }).then((r) => r.text());
    // The page is as it was: a "not seen" pill, no new status word.
    expect(page).toContain('>not seen</span>');
    expect(page).not.toContain('NOT_SEEN');
    expect(page).toContain('>waiting</span>');
    expect(page).toContain(
      'waiting for the client or the person to finish the flow'
    );

    // The run report says the same, in HTML, JSON and Markdown; the score
    // and verdict are unchanged.
    const report = await fetch(`${base}/results/wait`).then((r) => r.json());
    const row = report.columns[1].cells.find(
      (c: { scenario: string }) =>
        c.scenario === 'sep-2322-client-request-state'
    );
    expect(row).toMatchObject({
      verdict: 'incomplete',
      state: 'waiting',
      summary: { failed: 0, notSeen: 5 }
    });
    // What it waits for reads NOT_SEEN in the report's JSON too.
    type ReportFinding = { status: string; by: string };
    expect(
      row.findings.filter((f: ReportFinding) => f.status === 'FAILURE')
    ).toEqual([]);
    expect(
      row.findings.filter((f: ReportFinding) => f.status === 'NOT_SEEN')
    ).not.toHaveLength(0);
    expect(
      row.findings
        .filter((f: ReportFinding) => f.status === 'NOT_SEEN')
        .every((f: ReportFinding) => f.by === 'scenario')
    ).toBe(true);
    expect(report.columns[1].counts.waiting).toBe(1);
    const md = await fetch(`${base}/results/wait?format=md`).then((r) =>
      r.text()
    );
    expect(md).toMatch(
      /\| waiting \| 0 \/ 0 \/ 0 \| waiting for the client or the person to finish the flow/
    );
    expect(md).not.toContain('NOT_SEEN');
    const reportPage = await fetch(`${base}/results/wait`, {
      headers: { accept: 'text/html' }
    }).then((r) => r.text());
    expect(reportPage).toContain('1 waiting');
    // Plain lines for a chat that shows a Markdown table as raw pipes.
    expect(reportPage).toContain('copy for Slack');
    const text = await fetch(`${base}/results/wait?format=text`);
    expect(text.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await text.text()).toContain(
      `• ${REV_STATELESS} sep-2322-client-request-state: waiting, 0 / 0 / 0`
    );
  });

  it('says why each skipped check was skipped, and keeps them out of the counts', async () => {
    const res = await postMcp(
      `/s/skip/${REV_STATELESS}/http-standard-headers/mcp`,
      statelessBody('tools/list'),
      { ...statelessHeaders, 'mcp-method': 'tools/list' }
    );
    expect(res.status).toBe(200);
    await res.text();
    const cell = `/results/skip/${REV_STATELESS}/http-standard-headers`;
    type Row = { status: string; reason?: string; details?: unknown };
    const json = await fetch(`${base}${cell}`).then((r) => r.json());
    const skipped = json.checks.filter((c: Row) => c.status === 'SKIPPED');
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) {
      expect(c.reason).toMatch(/^Client did not send a /);
      expect(c.details).not.toBeNull();
    }
    const page = await fetch(`${base}${cell}`, {
      headers: { accept: 'text/html' }
    }).then((r) => r.text());
    expect(page).toContain(
      `<p>1 passed, 0 failed <span class=muted>· ${skipped.length} skipped: the client did nothing they check</span></p>`
    );
    expect(page).toContain('SKIPPED</span> Client did not send a tools/call');
  });

  it('explains an incomplete cell that lists failures, leading each failure with its reason', async () => {
    type Check = {
      id: string;
      status: string;
      description: string;
      details?: Record<string, unknown>;
    };
    const page = (path: string) =>
      fetch(`${base}${path}`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text()
      );
    // initialize alone: tools_call has seen nothing it tests, and judging
    // its empty log lists the tool call it still expects as a FAILURE.
    await postMcp(`/s/inc/${REV_STATEFUL}/tools_call/mcp`, initBody()).then(
      (r) => r.text()
    );
    const cell = `/results/inc/${REV_STATEFUL}/tools_call`;
    const json = await fetch(`${base}${cell}`).then((r) => r.json());
    expect(json.verdict).toBe('incomplete');
    // The scenario's own expectation, not the client's: NOT_SEEN in the JSON.
    expect(json.summary).toMatchObject({ failed: 0, notSeen: 1 });
    expect(json.note).toBe(
      'the client has not yet done anything this scenario tests; the failure listed is what it is still waiting for'
    );
    // tools_call gives its reason in details.message, not errorMessage.
    const failure = json.checks.find((c: Check) => c.status === 'NOT_SEEN');
    expect(failure.details.message).toBe('Tool was not called by client');

    const html = await page(cell);
    expect(html).not.toContain('nothing recorded yet');
    expect(html).toContain(json.note);
    // The headline is the reason; the check's own description stays below.
    expect(html).toContain(
      'not seen</span> Tool was not called by client</h3>'
    );
    expect(html).toContain(`${failure.description}</p>`);

    // The run report says the same, and does not count those failures.
    const report = await fetch(`${base}/results/inc`).then((r) => r.json());
    const inReport = report.columns[0].cells.find(
      (c: { scenario: string }) => c.scenario === 'tools_call'
    );
    expect(inReport).toMatchObject({ verdict: 'incomplete', note: json.note });
    const reportHtml = await page('/results/inc');
    expect(reportHtml).toContain('reached, nothing tested yet');

    // A client that only ever sent the legacy handshake is told so.
    await postMcp(
      `/s/inc/${REV_STATELESS}/tools_call/mcp`,
      {
        ...initBody(),
        params: { ...initBody().params, protocolVersion: REV_STATEFUL }
      },
      { 'mcp-protocol-version': REV_STATEFUL }
    ).then((r) => r.text());
    const legacy = await fetch(
      `${base}/results/inc/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    expect(legacy.verdict).toBe('incomplete');
    expect(legacy.note).toMatch(
      /^the client spoke 2025-11-25 only \(it opened with initialize\) and did not retry at 2026-07-28/
    );
  });

  it('reports a run with inline failures, causes, states, a frozen permalink and Markdown', async () => {
    const run = 'report1';
    const html = (path: string) =>
      fetch(`${base}${path}`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text()
      );
    type Finding = { check: string; reason: string; by: string };
    type Cell = {
      scenario: string;
      verdict: string;
      state: string;
      findings?: Finding[];
      cause?: string;
    };
    type Report = {
      snapshotId?: string;
      frozenAt?: string;
      columns: { revision: string; cells: Cell[]; notTried: Cell[] }[];
      causes: { key: string; text: string; cells: string[] }[];
    };
    const cellOf = (report: Report, rev: string, name: string) =>
      report.columns
        .find((c) => c.revision === rev)!
        .cells.find((c) => c.scenario === name)!;
    const XSS = '<img src=x onerror=alert(1)>';

    // pass, from a client whose name is markup
    await postMcp(`/s/${run}/${REV_STATEFUL}/initialize/mcp`, {
      ...initBody(),
      params: {
        ...initBody('vitest', REV_STATEFUL).params,
        clientInfo: { name: XSS, version: '1' }
      }
    }).then((r) => r.text());
    // in progress: reached, the tool never called
    await postMcp(`/s/${run}/${REV_STATEFUL}/tools_call/mcp`, initBody()).then(
      (r) => r.text()
    );
    // fail, seen in the client's traffic: no _meta
    await postMcp(
      `/s/${run}/${REV_STATELESS}/request-metadata/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      statelessHeaders
    ).then((r) => r.text());
    // fail, with markup in the header the failure quotes
    await postMcp(
      `/s/${run}/${REV_STATELESS}/json-schema-ref-no-deref/mcp`,
      statelessBody('tools/list'),
      { 'mcp-protocol-version': XSS }
    ).then((r) => r.text());
    // incomplete: a legacy initialize alone, on two cells
    const legacy = {
      ...initBody(),
      params: { ...initBody().params, protocolVersion: REV_STATEFUL }
    };
    for (const s of ['tools_call', 'http-standard-headers']) {
      await postMcp(`/s/${run}/${REV_STATELESS}/${s}/mcp`, legacy, {
        'mcp-protocol-version': REV_STATEFUL
      }).then((r) => r.text());
    }

    const report: Report = await fetch(`${base}/results/${run}`).then((r) =>
      r.json()
    );
    expect(cellOf(report, REV_STATEFUL, 'initialize').state).toBe('pass');
    expect(cellOf(report, REV_STATEFUL, 'tools_call')).toMatchObject({
      verdict: 'incomplete',
      state: 'in-progress',
      findings: [
        {
          check: 'tool-add-numbers',
          reason: 'Tool was not called by client',
          by: 'scenario'
        }
      ]
    });
    const metadata = cellOf(report, REV_STATELESS, 'request-metadata');
    expect(metadata.state).toBe('fail');
    expect(metadata.findings!.some((f) => f.by === 'client')).toBe(true);
    for (const s of ['tools_call', 'http-standard-headers']) {
      expect(cellOf(report, REV_STATELESS, s)).toMatchObject({
        verdict: 'incomplete',
        state: 'incomplete'
      });
    }
    expect(report.columns[1].cells.some((c) => c.state === 'not-tried')).toBe(
      true
    );
    // The legacy handshake is one cause over both cells it stopped.
    const legacyCause = report.causes.find((c) =>
      c.cells.includes(`${REV_STATELESS}/tools_call`)
    )!;
    expect(legacyCause.cells).toEqual(
      expect.arrayContaining([
        `${REV_STATELESS}/tools_call`,
        `${REV_STATELESS}/http-standard-headers`
      ])
    );
    expect(legacyCause.text).toMatch(/^The client spoke 2025-11-25 only/);
    expect(cellOf(report, REV_STATELESS, 'tools_call').cause).toBe(
      legacyCause.key
    );

    // The page: failures inline with their reasons, causes once, states.
    const page = await html(`/results/${run}`);
    expect(page).toContain('What went wrong, by cause');
    expect(page).toContain('Cells by revision');
    expect(page).toContain('<div>Tool was not called by client</div>');
    expect(page).toContain(
      metadata.findings![0].reason.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    );
    for (const state of [
      'pass',
      'fail',
      'in progress',
      'incomplete',
      'not tried'
    ]) {
      expect(page).toContain(`>${state}</span>`);
    }
    expect(page).toContain('freeze a copy to link to');
    // Traffic-derived markup is text, never markup.
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // Markdown: only the cells the client reached, whose failure is whose.
    const mdRes = await fetch(`${base}/results/${run}?format=md`);
    expect(mdRes.headers.get('content-type')).toMatch(/^text\/markdown/);
    const md = await mdRes.text();
    expect(md).toContain(
      '| Cell | Result | Pass / fail / warn | What happened |'
    );
    expect(md).toContain(`[${REV_STATEFUL} tools_call](`);
    expect(md).toContain('waiting for: Tool was not called by client');
    expect(md).toContain('client: `');
    expect(md).toMatch(/1\. Client: The client spoke 2025-11-25 only/);
    // Not tried: in its own group, with the URL to give the client.
    const elicitation = `${base}/s/${run}/${REV_STATEFUL}/elicitation-sep1034-client-defaults/mcp`;
    expect(md).toContain('your client never connected to these');
    expect(md).toContain(
      `| not tried | – | MCP URL \`${elicitation}\`; the client must connect, then list the tools`
    );
    // Escaped: `\<img` renders as text, never as a tag.
    expect(md).not.toMatch(/(^|[^\\])<img/m);
    expect(md).toContain('\\<img src=x onerror=alert(1)\\>');

    // Freeze: a permalink later traffic cannot change.
    const freeze = await fetch(`${base}/results/${run}/freeze`, {
      method: 'POST'
    });
    expect(freeze.status).toBe(201);
    const { snapshotId, url, frozenAt } = await freeze.json();
    expect(snapshotId).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(url).toBe(`${base}/results/${run}/snapshot/${snapshotId}`);
    expect(freeze.headers.get('location')).toBe(url);
    const before: Report = await fetch(url).then((r) => r.json());
    expect(before).toMatchObject({ snapshotId, frozenAt });

    await postMcp(
      `/s/${run}/${REV_STATEFUL}/initialize/mcp`,
      initBody('second-client')
    ).then((r) => r.text());
    await postMcp(`/s/${run}/${REV_STATELESS}/request-metadata/mcp`, legacy, {
      'mcp-protocol-version': REV_STATEFUL
    }).then((r) => r.text());
    const later = 'elicitation-sep1034-client-defaults';
    await postMcp(`/s/${run}/${REV_STATEFUL}/${later}/mcp`, initBody()).then(
      (r) => r.text()
    );
    const live: Report = await fetch(`${base}/results/${run}`).then((r) =>
      r.json()
    );
    expect(cellOf(live, REV_STATEFUL, later).state).not.toBe('not-tried');
    expect(await fetch(url).then((r) => r.json())).toEqual(before);
    expect(cellOf(before, REV_STATEFUL, later).state).toBe('not-tried');

    const frozenPage = await html(`/results/${run}/snapshot/${snapshotId}`);
    expect(frozenPage).toContain('A frozen copy, taken');
    expect(frozenPage).not.toContain('freeze a copy to link to');
    expect(frozenPage).not.toContain('<img src=x');
    const frozenMd = await fetch(`${url}?format=md`).then((r) => r.text());
    expect(frozenMd).toContain(`Frozen ${frozenAt.slice(0, 10)}`);
    expect(frozenMd).toContain(url);
    // A frozen copy is grouped when it is read, from what it stored.
    expect(frozenMd).toContain(`MCP URL \`${elicitation}\``);
    expect(frozenPage).toContain('Cells by revision');
    expect(frozenPage).toContain(`data-copy-text="${elicitation}"`);
    const frozenCol = before.columns.find((c) => c.revision === REV_STATEFUL)!;
    expect(frozenCol.notTried.find((c) => c.scenario === later)).toMatchObject({
      state: 'not-tried',
      mcpUrl: elicitation
    });
    // The live page lists its frozen copies.
    expect(await html(`/results/${run}`)).toContain(
      `/results/${run}/snapshot/${snapshotId}`
    );
    // A browser's form post lands on the frozen copy.
    const viaForm = await fetch(`${base}/results/${run}/freeze`, {
      method: 'POST',
      headers: { accept: 'text/html' },
      redirect: 'manual'
    });
    expect(viaForm.status).toBe(303);
    expect(viaForm.headers.get('location')).toMatch(
      new RegExp(`^/results/${run}/snapshot/[0-9a-z]{8}$`)
    );

    expect(
      (await fetch(`${base}/results/${run}/snapshot/nope0000`)).status
    ).toBe(404);
    expect((await fetch(`${base}/results/${run}/snapshot`)).status).toBe(404);
    // Deleting the run deletes its snapshots too.
    await fetch(`${base}/results/${run}`, { method: 'DELETE' });
    expect((await fetch(url)).status).toBe(404);
  });

  it('never changes results by reading them', async () => {
    const page = (path: string) =>
      fetch(`${base}${path}`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text()
      );
    const json = (path: string) =>
      fetch(`${base}${path}`).then((r) => r.json());

    // A cell only its config page created has seen no client: nothing to
    // judge, however often its results are viewed.
    await page(`/s/view/${REV_STATEFUL}/tools_call`);
    for (let i = 0; i < 3; i++) {
      await page(`/results/view/${REV_STATEFUL}/tools_call`);
    }
    await page('/results/view');
    expect(
      await json(`/results/view/${REV_STATEFUL}/tools_call`)
    ).toMatchObject({
      verdict: 'incomplete',
      summary: { failed: 0, total: 0 },
      checks: []
    });
    const fresh = sessions.get(
      cellId({
        runId: 'view',
        revision: REV_STATEFUL,
        scenarioName: 'tools_call'
      })
    )!;
    expect(rawChecksOf(fresh.scenario)).toEqual([]);

    // http-custom-headers appends its "never seen" FAILUREs to its log when
    // judged: reading a touched cell must leave the log and verdict alone.
    await postMcp(
      `/s/view/${REV_STATELESS}/http-custom-headers/mcp`,
      statelessBody('tools/list'),
      { ...statelessHeaders, 'mcp-method': 'tools/list' }
    ).then((r) => r.text());
    const touched = sessions.get(
      cellId({
        runId: 'view',
        revision: REV_STATELESS,
        scenarioName: 'http-custom-headers'
      })
    )!;
    const rawBefore = rawChecksOf(touched.scenario).length;
    const cell = `/results/view/${REV_STATELESS}/http-custom-headers`;
    const first = await json(cell);
    for (let i = 0; i < 3; i++) {
      await page(cell);
      await page('/results/view');
    }
    const last = await json(cell);
    expect(rawChecksOf(touched.scenario)).toHaveLength(rawBefore);
    expect(last.verdict).toBe(first.verdict);
    expect(last.summary).toEqual(first.summary);
  });

  it('answers a GET on an MCP path it serves no stream on with 405, and notes it', async () => {
    // VS Code sends this after a 400, as its old HTTP+SSE fallback; these
    // scenarios' express apps have no GET route, so it used to get
    // Express's HTML "Cannot GET" 404.
    const sse = { accept: 'text/event-stream' };
    for (const path of [
      `/s/getx/${REV_STATELESS}/tools_call/mcp`,
      `/s/getx/${REV_STATEFUL}/tools_call/mcp`,
      `/s/getx/${REV_STATELESS}/json-schema-ref-no-deref/mcp`
    ]) {
      const r = await fetch(`${base}${path}`, { headers: sse });
      expect(r.status, path).toBe(405);
      expect(r.headers.get('allow'), path).toBe('POST');
      expect(await r.json(), path).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null
      });
    }
    const results = await fetch(
      `${base}/results/getx/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    expect(
      results.checks
        .filter((c: { id: string }) => c.id === 'hosted-get-on-mcp-path')
        .map((c: { status: string }) => c.status)
    ).toEqual(['INFO']);
    expect(results.verdict).toBe('incomplete');

    // A scenario that serves a stream there still does.
    const ctl = new AbortController();
    const stream = await fetch(
      `${base}/s/getx/${REV_STATELESS}/http-standard-headers/mcp`,
      { headers: sse, signal: ctl.signal }
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    ctl.abort();

    // A browser opening an MCP URL is sent to the cell's page, query kept.
    const page = await fetch(
      `${base}/s/getx/${REV_STATELESS}/tools_call/mcp?format=html`,
      { headers: { accept: 'text/html' }, redirect: 'manual' }
    );
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(
      `${base}/s/getx/${REV_STATELESS}/tools_call?format=html`
    );
  });

  it("answers an older initialize on a dated cell with the cell's revision", async () => {
    // A live case: initialize asking 2025-06-18 on a 2025-11-25 cell.
    // The bundled servers would echo 2025-06-18 and the cell would then fail
    // the client for speaking it; the cell tests 2025-11-25, so it says so.
    type Check = {
      id: string;
      status: string;
      details?: Record<string, unknown>;
    };
    const olderInit = initBody(); // asks 2025-06-18
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 5, b: 3 } }
    };
    const dated = { 'mcp-protocol-version': REV_STATEFUL };
    const older = { 'mcp-protocol-version': '2025-06-18' };
    const resultsOf = (run: string, name: string) =>
      fetch(`${base}/results/${run}/${REV_STATEFUL}/${name}`).then((r) =>
        r.json()
      );

    // The SDK's server (SSE), and the raw initialize scenario (plain JSON,
    // Content-Length intact).
    for (const [run, name] of [
      ['pin', 'tools_call'],
      ['pin', 'initialize']
    ]) {
      const r = await postMcp(
        `/s/${run}/${REV_STATEFUL}/${name}/mcp`,
        olderInit
      );
      expect(r.status, name).toBe(200);
      const text = await r.text();
      expect(text, name).toContain(`"protocolVersion":"${REV_STATEFUL}"`);
      expect(text, name).not.toContain('2025-06-18');
      const results = await resultsOf(run, name);
      expect(
        results.checks.filter((c: Check) => c.id === 'hosted-version-offered'),
        name
      ).toEqual([
        expect.objectContaining({
          status: 'INFO',
          details: {
            served: REV_STATEFUL,
            requestedVersion: '2025-06-18',
            answeredVersion: REV_STATEFUL
          }
        })
      ]);
    }

    // A client that then speaks 2025-11-25 passes cleanly…
    const url = `/s/pin/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(url, call, dated).then((r) => r.text());
    const clean = await resultsOf('pin', 'tools_call');
    expect(clean.checks.filter((c: Check) => c.status === 'FAILURE')).toEqual(
      []
    );
    expect(clean.verdict).toBe('pass');

    // …one that keeps its own 2025-06-18 is at the wrong revision.
    const stubborn = `/s/pin2/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(stubborn, olderInit).then((r) => r.text());
    await postMcp(stubborn, call, older).then((r) => r.text());
    const kept = await resultsOf('pin2', 'tools_call');
    expect(
      kept.checks
        .filter((c: Check) => c.status === 'FAILURE')
        .map((c: Check) => [c.id, c.details?.headerVersion])
    ).toEqual([['hosted-wrong-revision', '2025-06-18']]);
    expect(kept.verdict).toBe('fail');

    // A client that asks for the cell's revision gets no note.
    const exact = `/s/pin3/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(exact, {
      ...olderInit,
      params: { ...olderInit.params, protocolVersion: REV_STATEFUL }
    }).then((r) => r.text());
    const quiet = await resultsOf('pin3', 'tools_call');
    expect(
      quiet.checks.some((c: Check) => c.id === 'hosted-version-offered')
    ).toBe(false);
  });

  it('treats a rejected foreign-revision probe on a dated cell as negotiation', async () => {
    type Check = {
      id: string;
      status: string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    };
    const hostedChecks = (checks: Check[]) =>
      checks.filter((c) => c.id.startsWith('hosted-w'));
    const probesIn = (checks: Check[]) =>
      checks.filter((c) => c.id === 'hosted-modern-probe');
    const resultsOf = (run: string, rev: string, name: string) =>
      fetch(`${base}/results/${run}/${rev}/${name}`).then((r) => r.json());
    const verdictOf = async (run: string, rev: string, name: string) => {
      const report = await fetch(`${base}/results/${run}`).then((r) =>
        r.json()
      );
      return report.columns
        .find((c: { revision: string }) => c.revision === rev)
        .cells.find((c: { scenario: string }) => c.scenario === name).verdict;
    };
    const negotiatedInit = {
      ...initBody(),
      params: { ...initBody().params, protocolVersion: REV_STATEFUL }
    };
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 1, b: 2 } }
    };

    // Felix's live case, since seen from a second client: a client opens a
    // dated cell with server/discover at 2026-07-28, the SDK transport turns
    // the header away, and the client falls back to initialize at 2025-11-25 and
    // carries on there. The rejected probe is negotiation: noted once as an
    // INFO modern probe with the answer it drew, neither FAILURE, verdict
    // pass.
    const url = `/s/neg/${REV_STATEFUL}/tools_call/mcp`;
    const probe = await postMcp(
      url,
      statelessBody('server/discover'),
      statelessHeaders
    );
    expect(probe.status).toBe(400);
    expect((await probe.json()).error.message).toContain(
      'Unsupported protocol version'
    );
    const init = await postMcp(url, negotiatedInit);
    expect(init.status).toBe(200);
    expect(await init.text()).toContain(`"protocolVersion":"${REV_STATEFUL}"`);
    const dated = { 'mcp-protocol-version': REV_STATEFUL };
    const initialized = await postMcp(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      dated
    );
    expect(initialized.status).toBe(202);
    await initialized.text();
    await postMcp(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      dated
    ).then((r) => r.text());
    await postMcp(url, call, dated).then((r) => r.text());
    const negotiated = await resultsOf('neg', REV_STATEFUL, 'tools_call');
    expect(hostedChecks(negotiated.checks)).toEqual([]);
    expect(
      negotiated.checks.filter(
        (c: Check) => c.id.startsWith('hosted-') && c.status === 'FAILURE'
      )
    ).toEqual([]);
    expect(probesIn(negotiated.checks)).toEqual([
      expect.objectContaining({
        status: 'INFO',
        details: {
          served: REV_STATEFUL,
          method: 'server/discover',
          headerVersion: REV_STATELESS,
          rejected: {
            status: 400,
            code: -32000,
            message: expect.stringContaining(
              `Unsupported protocol version: ${REV_STATELESS}`
            )
          }
        }
      })
    ]);
    expect(
      negotiated.checks.find((c: Check) => c.id === 'tool-add-numbers').status
    ).toBe('SUCCESS');
    expect(await verdictOf('neg', REV_STATEFUL, 'tools_call')).toBe('pass');

    // Every dated cell answers it alike, before the scenario sees it: the
    // raw initialize scenario answered 404 -32601 here, which on HTTP is a
    // modern server saying it lacks the method.
    const rawCell = `/s/neg3/${REV_STATEFUL}/initialize/mcp`;
    const rawProbe = await postMcp(
      rawCell,
      statelessBody('server/discover'),
      statelessHeaders
    );
    expect(rawProbe.status).toBe(400);
    expect(await rawProbe.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: `Bad Request: Unsupported protocol version: ${REV_STATELESS} (supported versions: ${REV_STATEFUL})`
      }
    });
    await postMcp(rawCell, negotiatedInit).then((r) => r.text());
    const raw = await resultsOf('neg3', REV_STATEFUL, 'initialize');
    expect(hostedChecks(raw.checks)).toEqual([]);
    expect(
      probesIn(raw.checks).map(
        (c) => (c.details?.rejected as { code?: number }).code
      )
    ).toEqual([-32000]);
    expect(await verdictOf('neg3', REV_STATEFUL, 'initialize')).toBe('pass');

    // A client that negotiated and then carried on at 2026-07-28: the wire
    // accepted the request, so it is a wrong revision, not negotiation.
    const initCell = `/s/neg/${REV_STATEFUL}/initialize/mcp`;
    await postMcp(initCell, negotiatedInit).then((r) => r.text());
    const carriedOn = await postMcp(
      initCell,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      statelessHeaders
    );
    expect(carriedOn.status).toBe(200);
    await carriedOn.text();
    const continued = await resultsOf('neg', REV_STATEFUL, 'initialize');
    expect(hostedChecks(continued.checks).map((c) => c.errorMessage)).toEqual([
      `cell is served on ${REV_STATEFUL}; client sent ${REV_STATELESS}`
    ]);
    expect(await verdictOf('neg', REV_STATEFUL, 'initialize')).toBe('fail');

    // …and one that negotiated, then sent a 2026-07-28 request again: the
    // wire turns it away, and a request in the 2026-07-28 shape is the
    // client probing again (it may, whenever it reconnects), so it is only
    // noted; the tool was never called at 2025-11-25, so the cell is not
    // done: its one failure is the call it has not seen.
    const other = `/s/neg2/${REV_STATEFUL}/tools_call/mcp`;
    await postMcp(
      other,
      statelessBody('server/discover'),
      statelessHeaders
    ).then((r) => r.text());
    await postMcp(other, negotiatedInit).then((r) => r.text());
    await postMcp(
      other,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      dated
    ).then((r) => r.text());
    const rejectedCall = await postMcp(
      other,
      statelessBody('tools/call', call.params),
      statelessHeaders
    );
    expect(rejectedCall.status).toBe(400);
    await rejectedCall.text();
    const never = await resultsOf('neg2', REV_STATEFUL, 'tools_call');
    expect(hostedChecks(never.checks)).toEqual([]);
    expect(probesIn(never.checks)).toHaveLength(1);
    expect(
      never.checks.find((c: Check) => c.id === 'tool-add-numbers').status
    ).toBe('NOT_SEEN');
    expect(await verdictOf('neg2', REV_STATEFUL, 'tools_call')).toBe(
      'incomplete'
    );

    // A request in the dated shape (no per-request _meta) whose header names
    // 2026-07-28 is carrying on at the wrong revision, not probing.
    const legacyShaped = await postMcp(
      other,
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      statelessHeaders
    );
    expect(legacyShaped.status).toBe(400);
    await legacyShaped.text();
    // Deliberately not a 2026-07-28 request, though its header says so.
    expect(takeWireViolations().violations).toHaveLength(1);
    expect(
      hostedChecks(
        (await resultsOf('neg2', REV_STATEFUL, 'tools_call')).checks
      ).map((c) => [c.id, c.details?.method])
    ).toEqual([['hosted-wrong-revision', 'tools/list']]);

    // Probing alone, however often: noted once per version, never failed —
    // and never passed either, since the client never spoke 2025-11-25.
    const stubborn = `/s/neg4/${REV_STATEFUL}/tools_call/mcp`;
    for (const method of ['server/discover', 'tools/list', 'server/discover']) {
      const r = await postMcp(
        stubborn,
        statelessBody(method),
        statelessHeaders
      );
      expect(r.status, method).toBe(400);
      await r.text();
    }
    const kept = await resultsOf('neg4', REV_STATEFUL, 'tools_call');
    expect(probesIn(kept.checks)).toHaveLength(1);
    expect(hostedChecks(kept.checks)).toEqual([]);
    expect(
      kept.checks.some((c: Check) => c.id === 'hosted-wire-rejected')
    ).toBe(false);
    expect(await verdictOf('neg4', REV_STATEFUL, 'tools_call')).toBe(
      'incomplete'
    );

    // On the 2026-07-28 cell nothing is negotiation: a 2025-11-25 header the
    // scenario accepted is a wrong revision, as before.
    const stateless = `/s/neg/${REV_STATELESS}/http-standard-headers/mcp`;
    const accepted = await postMcp(
      stateless,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      dated
    );
    expect(accepted.status).toBe(200);
    await accepted.text();
    const wrong = await resultsOf(
      'neg',
      REV_STATELESS,
      'http-standard-headers'
    );
    expect(hostedChecks(wrong.checks).map((c) => c.errorMessage)).toEqual([
      `cell is served on ${REV_STATELESS}; client sent ${REV_STATEFUL}`
    ]);
  });

  it('keeps a dual-era client that probes on every connect passing', async () => {
    // A dual-era client, as run live: on every connect (start-up,
    // /mcp, a relaunch) it sends server/discover at 2026-07-28, is turned
    // away, asks for 2025-06-18 in initialize, is told 2025-11-25 and
    // carries on at 2025-11-25. A GET with a 2024-11-05 header comes too.
    type Check = {
      id: string;
      status: string;
      details?: Record<string, unknown>;
    };
    const dated = { 'mcp-protocol-version': REV_STATEFUL };
    const answers: Record<string, unknown> = {};
    const connect = async (name: string) => {
      const url = `/s/relaunch/${REV_STATEFUL}/${name}/mcp`;
      const probe = await postMcp(
        url,
        statelessBody('server/discover'),
        statelessHeaders
      );
      expect(probe.status, name).toBe(400);
      answers[name] = await probe.json();
      const init = await postMcp(url, initBody('dual-era'));
      expect(await init.text()).toContain(
        `"protocolVersion":"${REV_STATEFUL}"`
      );
      const initialized = await postMcp(
        url,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        dated
      );
      expect(initialized.status, name).toBe(202);
      await initialized.text();
      const listed = await postMcp(
        url,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        dated
      );
      expect(listed.status, name).toBe(200);
      await listed.text();
      const get = await fetch(`${base}${url}`, {
        headers: {
          accept: 'text/event-stream',
          'mcp-protocol-version': '2024-11-05'
        }
      });
      expect(get.status, name).toBe(405);
      await get.text();
    };
    for (const name of ['tools_call', 'initialize']) {
      await connect(name);
      if (name === 'tools_call') {
        await postMcp(
          `/s/relaunch/${REV_STATEFUL}/tools_call/mcp`,
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add_numbers', arguments: { a: 5, b: 3 } }
          },
          dated
        ).then((r) => r.text());
      }
      // Two relaunches.
      await connect(name);
      await connect(name);
    }
    // Every dated cell turns the probe away with the same answer.
    expect(answers.initialize).toEqual(answers.tools_call);

    const report = await fetch(`${base}/results/relaunch`).then((r) =>
      r.json()
    );
    const column = report.columns.find(
      (c: { revision: string }) => c.revision === REV_STATEFUL
    );
    for (const name of ['tools_call', 'initialize']) {
      const results = await fetch(
        `${base}/results/relaunch/${REV_STATEFUL}/${name}`
      ).then((r) => r.json());
      expect(
        results.checks.filter((c: Check) => c.status === 'FAILURE'),
        name
      ).toEqual([]);
      // One note for the probe, however many times it came; the GET is not
      // a probe.
      expect(
        results.checks
          .filter((c: Check) => c.id === 'hosted-modern-probe')
          .map((c: Check) => [c.details?.method, c.details?.headerVersion]),
        name
      ).toEqual([['server/discover', REV_STATELESS]]);
      expect(
        results.checks.filter((c: Check) => c.id === 'hosted-get-on-mcp-path'),
        name
      ).toHaveLength(1);
      expect(results.verdict, name).toBe('pass');
      expect(
        column.cells.find((c: { scenario: string }) => c.scenario === name)
          .verdict,
        name
      ).toBe('pass');
    }
  });

  it('keeps a repeated legacy initialize on a 2026-07-28 cell a probe', async () => {
    // The mirror case: a dual-era client that opens every connect with
    // initialize, is answered -32022 and carries on at 2026-07-28.
    type Check = { id: string; status: string };
    const url = `/s/legacy2/${REV_STATELESS}/tools_call/mcp`;
    for (let connect = 0; connect < 3; connect++) {
      const init = await postMcp(url, initBody('dual'));
      expect(init.status).toBe(400);
      expect((await init.json()).error.code).toBe(-32022);
      await postMcp(url, statelessBody('tools/list'), {
        ...statelessHeaders,
        'mcp-method': 'tools/list'
      }).then((r) => r.text());
    }
    await postMcp(
      url,
      statelessBody('tools/call', {
        name: 'add_numbers',
        arguments: { a: 1, b: 2 }
      }),
      {
        ...statelessHeaders,
        'mcp-method': 'tools/call',
        'mcp-name': 'add_numbers'
      }
    ).then((r) => r.text());
    const results = await fetch(
      `${base}/results/legacy2/${REV_STATELESS}/tools_call`
    ).then((r) => r.json());
    expect(results.checks.filter((c: Check) => c.status === 'FAILURE')).toEqual(
      []
    );
    expect(
      results.checks.filter((c: Check) => c.id === 'hosted-legacy-probe')
    ).toHaveLength(1);
    expect(results.verdict).toBe('pass');
  });

  it('turns server/discover away alike on dated cells and composites', async () => {
    type Check = { id: string; status: string };
    const probe = (url: string) =>
      postMcp(url, statelessBody('server/discover'), statelessHeaders).then(
        async (r) => ({ status: r.status, body: await r.json() })
      );
    const single = await probe(`/s/cdisc/${REV_STATEFUL}/tools_call/mcp`);
    const composite = await probe(
      `/s/cdisc/${REV_STATEFUL}/initialize+tools_call/mcp`
    );
    expect(single.status).toBe(400);
    expect(composite).toEqual(single);
    for (const name of ['initialize', 'tools_call']) {
      const results = await fetch(
        `${base}/results/cdisc/${REV_STATEFUL}/${name}`
      ).then((r) => r.json());
      expect(
        results.checks.filter(
          (c: Check) => c.id.startsWith('hosted-') && c.status === 'FAILURE'
        ),
        name
      ).toEqual([]);
      expect(
        results.checks.filter((c: Check) => c.id === 'hosted-modern-probe'),
        name
      ).toHaveLength(1);
    }
  });

  it('answers an empty or malformed body with a plain parse error', async () => {
    // Single cells on both wires, a raw scenario, and a composite: one
    // answer, and no parser exception anywhere.
    type Check = { id: string; status: string; details?: unknown };
    const cells = [
      `/s/parse/${REV_STATEFUL}/tools_call/mcp`,
      `/s/parse/${REV_STATEFUL}/initialize/mcp`,
      `/s/parse/${REV_STATELESS}/tools_call/mcp`,
      `/s/parse/${REV_STATELESS}/tools_call+http-standard-headers/mcp`
    ];
    for (const url of cells) {
      for (const body of ['', '{"jsonrpc":"2.0","id":1,"method":']) {
        const r = await fetch(`${base}${url}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2024-11-05'
          },
          body
        });
        expect(r.status, `${url} ${JSON.stringify(body)}`).toBe(400);
        expect(await r.json()).toEqual({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        });
      }
    }
    // A bodiless POST with no Content-Type is the same parse error.
    const bare = await fetch(`${base}${cells[1]}`, { method: 'POST' });
    expect(bare.status).toBe(400);
    expect((await bare.json()).error.code).toBe(-32700);

    for (const cell of [
      `parse/${REV_STATEFUL}/tools_call`,
      `parse/${REV_STATEFUL}/initialize`,
      `parse/${REV_STATELESS}/tools_call`
    ]) {
      const results = await fetch(`${base}/results/${cell}`).then((r) =>
        r.text()
      );
      expect(results, cell).not.toContain('SyntaxError');
      const checks: Check[] = JSON.parse(results).checks;
      expect(
        checks.filter((c) => c.id.startsWith('hosted-') && c.status !== 'INFO'),
        cell
      ).toEqual([]);
      expect(
        checks.some((c) => c.id === 'hosted-modern-probe'),
        cell
      ).toBe(false);
      expect(
        checks
          .filter((c) => c.id === 'hosted-unparseable-body')
          .map((c) => (c.details as { body: string }).body)
          .sort(),
        cell
      ).toEqual(['empty', 'malformed']);
    }
  });

  it("says in initialize's check whether the client asked for the cell's revision", async () => {
    type Check = {
      id: string;
      status: string;
      details?: Record<string, unknown>;
    };
    const checkOf = async (run: string, version: string) => {
      await postMcp(
        `/s/${run}/${REV_STATEFUL}/initialize/mcp`,
        initBody('vm', version)
      ).then((r) => r.text());
      const results = await fetch(
        `${base}/results/${run}/${REV_STATEFUL}/initialize`
      ).then((r) => r.json());
      return results.checks.find(
        (c: Check) => c.id === 'mcp-client-initialization'
      ) as Check;
    };
    const older = await checkOf('vm1', '2025-06-18');
    expect(older.status).toBe('SUCCESS');
    expect(older.details).toMatchObject({
      protocolVersionSent: '2025-06-18',
      expectedSpecVersion: REV_STATEFUL,
      versionMatch: false
    });
    const exact = await checkOf('vm2', REV_STATEFUL);
    expect(exact.details).toMatchObject({
      protocolVersionSent: REV_STATEFUL,
      expectedSpecVersion: REV_STATEFUL,
      versionMatch: true
    });
  });

  it('does not pass a cell where the client never spoke its revision', async () => {
    // The client asked for 2025-06-18, was told 2025-11-25, and said
    // nothing more: its handshake checks passed, but 2025-11-25 was never
    // tested.
    type Check = { id: string; status: string };
    await postMcp(
      `/s/mute/${REV_STATEFUL}/initialize/mcp`,
      initBody('mute')
    ).then((r) => r.text());
    const quiet = await fetch(
      `${base}/results/mute/${REV_STATEFUL}/initialize`
    ).then((r) => r.json());
    expect(quiet.checks.filter((c: Check) => c.status === 'FAILURE')).toEqual(
      []
    );
    expect(quiet.verdict).toBe('incomplete');
    expect(
      quiet.checks.filter((c: Check) => c.id === 'hosted-revision-not-spoken')
    ).toEqual([
      expect.objectContaining({
        status: 'INFO',
        description: expect.stringContaining(
          `The client never spoke ${REV_STATEFUL} here`
        )
      })
    ]);
    // The marker that decides it is never shown.
    expect(
      quiet.checks.some((c: Check) => c.id === 'hosted-revision-spoken')
    ).toBe(false);

    // Once it does, the cell passes, and the note is gone.
    await postMcp(
      `/s/mute/${REV_STATEFUL}/initialize/mcp`,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-protocol-version': REV_STATEFUL }
    ).then((r) => r.text());
    const spoke = await fetch(
      `${base}/results/mute/${REV_STATEFUL}/initialize`
    ).then((r) => r.json());
    expect(spoke.verdict).toBe('pass');
    expect(
      spoke.checks.some(
        (c: Check) =>
          c.id === 'hosted-revision-not-spoken' ||
          c.id === 'hosted-revision-spoken'
      )
    ).toBe(false);
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
    expect(html).not.toContain('<script>x</script>');
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

  it('serves a frozen report from any process', async () => {
    const [a, b] = origins;
    await fetch(`${a}/s/frz/${REV_STATEFUL}/initialize/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: REV_STATEFUL,
          clientInfo: { name: 'frz', version: '0' },
          capabilities: {}
        }
      })
    }).then((r) => r.text());
    await apps[0].sessions.flush();
    const frozen = await fetch(`${a}/results/frz/freeze`, {
      method: 'POST'
    }).then((r) => r.json());
    const onB = await fetch(`${b}/results/frz/snapshot/${frozen.snapshotId}`);
    expect(onB.status).toBe(200);
    const report = await onB.json();
    expect(report).toMatchObject({
      runId: 'frz',
      snapshotId: frozen.snapshotId,
      frozenAt: frozen.frozenAt
    });
    const cell = report.columns[0].cells.find(
      (c: { scenario: string }) => c.scenario === 'initialize'
    );
    expect(cell.state).toBe('pass');
    // Cell links are the serving process's, not the one it was frozen on.
    expect(cell.resultsUrl).toBe(`${b}/results/frz/${REV_STATEFUL}/initialize`);
    expect(await store.listSnapshots('frz')).toHaveLength(1);
  });

  it('keeps a probing client passing when its connects land on different processes', async () => {
    // The dual-era client of the single-process case, with each request
    // load-balanced to the other isolate: neither judges a probe from what
    // it has seen before, so no order of arrival can fail it.
    const [a, b] = origins;
    let turn = 0;
    const post = (
      path: string,
      body: object,
      headers: Record<string, string> = {}
    ) =>
      fetch(`${[a, b][turn++ % 2]}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers
        },
        body: JSON.stringify(body)
      }).then(async (r) => {
        await r.text();
        return r.status;
      });
    const url = `/s/mpprobe/${REV_STATEFUL}/tools_call/mcp`;
    const dated = { 'mcp-protocol-version': REV_STATEFUL };
    const discover = {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
          'io.modelcontextprotocol/clientInfo': { name: 'mp', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    };
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'mp', version: '0' },
        capabilities: {}
      }
    };
    for (let connect = 0; connect < 3; connect++) {
      expect(
        await post(url, discover, { 'mcp-protocol-version': REV_STATELESS })
      ).toBe(400);
      expect(await post(url, init)).toBe(200);
      expect(
        await post(
          url,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          dated
        )
      ).toBe(202);
      if (connect === 0) {
        expect(
          await post(
            url,
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'add_numbers', arguments: { a: 1, b: 2 } }
            },
            dated
          )
        ).toBe(200);
      }
    }
    for (const { sessions } of apps) await sessions.flush();
    type Check = { id: string; status: string };
    for (const origin of [a, b]) {
      const results = await fetch(
        `${origin}/results/mpprobe/${REV_STATEFUL}/tools_call`
      ).then((r) => r.json());
      expect(
        results.checks.filter((c: Check) => c.status === 'FAILURE')
      ).toEqual([]);
      expect(
        results.checks.filter((c: Check) => c.id === 'hosted-modern-probe')
      ).toHaveLength(1);
      expect(results.verdict).toBe('pass');
    }
  });

  it('writes nothing to the store when results are read', async () => {
    const [a, b] = origins;
    const html = { headers: { accept: 'text/html' } };
    // A cell only a config page created: nothing stored, nothing judged.
    const freshId = `viewst/${REV_STATEFUL}/tools_call`;
    await fetch(`${a}/s/${freshId}`, html).then((r) => r.text());
    for (const o of [a, b, a]) {
      await fetch(`${o}/results/${freshId}`, html).then((r) => r.text());
    }
    expect(await store.loadRun(freshId)).toBeUndefined();
    expect((await store.loadChecks(freshId)).size).toBe(0);
    // The live server's case: the process that served the cell page holds a
    // scenario instance the other does not. Reads from either, at every
    // scope, must agree — nothing failed, nothing to judge yet.
    const cellOf = (report: {
      columns: {
        cells: { scenario: string; verdict: string; summary?: unknown }[];
      }[];
    }) => report.columns[0].cells.find((c) => c.scenario === 'tools_call')!;
    for (let round = 0; round < 3; round++) {
      for (const o of [a, b]) {
        expect(
          await fetch(`${o}/results/${freshId}`).then((r) => r.json())
        ).toMatchObject({
          verdict: 'incomplete',
          summary: { failed: 0, total: 0 }
        });
        for (const scope of [`viewst/${REV_STATEFUL}`, 'viewst']) {
          const cell = cellOf(
            await fetch(`${o}/results/${scope}`).then((r) => r.json())
          );
          expect(cell.verdict).toBe('incomplete');
          expect(cell.summary).toBeUndefined();
        }
      }
    }

    // A touched cell: its rows are what the traffic wrote, however often
    // either process reads it.
    const id = `viewst/${REV_STATELESS}/http-custom-headers`;
    await fetch(`${a}/s/${id}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': REV_STATELESS,
        'mcp-method': 'tools/list'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    }).then((r) => r.text());
    await apps[0].sessions.flush();
    const rows = () =>
      store.loadChecks(id).then((m) => JSON.stringify([...m.entries()]));
    const written = await rows();
    const first = await fetch(`${a}/results/${id}`).then((r) => r.json());
    for (const o of [a, b, a, b]) {
      await fetch(`${o}/results/${id}`, html).then((r) => r.text());
    }
    for (const { sessions } of apps) await sessions.flush();
    expect(await rows()).toBe(written);
    const last = await fetch(`${b}/results/${id}`).then((r) => r.json());
    expect(last.verdict).toBe(first.verdict);
    expect(last.summary).toEqual(first.summary);
  });

  it('passes tools_call when tools/list and tools/call land on different processes', async () => {
    const path = `/s/split/${REV_STATELESS}/tools_call/mcp`;
    const meta = {
      'io.modelcontextprotocol/protocolVersion': REV_STATELESS,
      'io.modelcontextprotocol/clientCapabilities': {}
    };
    const send = (origin: string, body: object) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': REV_STATELESS
        },
        body: JSON.stringify(body)
      }).then((r) => r.text());
    await send(origins[0], {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: meta }
    });
    await apps[0].sessions.flush();
    await send(origins[1], {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { _meta: meta, name: 'add_numbers', arguments: { a: 2, b: 3 } }
    });
    await apps[1].sessions.flush();
    for (const origin of origins) {
      const results = await fetch(
        `${origin}/results/split/${REV_STATELESS}/tools_call`
      ).then((r) => r.json());
      expect(
        results.checks.find((c: { id: string }) => c.id === 'tool-add-numbers')
      ).toMatchObject({ status: 'SUCCESS', details: { result: 5 } });
    }
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
