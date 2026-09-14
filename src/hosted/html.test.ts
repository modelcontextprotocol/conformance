import { beforeAll, describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import {
  duration,
  escapeHtml as esc,
  jsonForScript,
  prose,
  renderComposite,
  renderConfig,
  renderLanding,
  renderMatrixTable,
  renderReport,
  renderResults,
  REPO_URL
} from './html';
import type { RunConfig } from './server';
import { buildReport, withNotTriedHints } from './report';
import { scoreText } from './markdown';
import { cellId, DEFAULT_CELL_TTL_MS } from './session';
import { describeStep } from '../steps';
import { CLIENTS } from './client-config';
import { identityCheck, identityOf } from './identity';
import { hostedScenarios } from './catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

const matrix = buildMatrix({ exclude: { 'sse-retry': 'excluded <here>' } });

function configFor(runId: string, scope: Partial<RunConfig> = {}): RunConfig {
  const cells = matrix
    .cells()
    .filter(
      (c) =>
        c.startable &&
        (!scope.revision || c.revision === scope.revision) &&
        (!scope.scenario || c.scenario === scope.scenario)
    )
    .map((c) => ({
      scenario: c.scenario,
      revision: c.revision,
      url: `http://x/s/${runId}/${c.revision}/${c.scenario}${c.mcpPath}`,
      resultsUrl: `http://x/results/${runId}/${c.revision}/${c.scenario}`,
      scoring: c.scoring,
      ...(c.steps && { steps: c.steps }),
      env: {
        MCP_CONFORMANCE_SCENARIO: c.scenario,
        MCP_CONFORMANCE_PROTOCOL_VERSION: c.revision,
        MCP_CONFORMANCE_CONTEXT: JSON.stringify({
          name: c.scenario,
          x: '</script>'
        })
      }
    }));
  return {
    runId,
    ...scope,
    resultsUrl: `http://x/results/${runId}`,
    mcpServers: Object.fromEntries(
      cells.map((c) => [
        `${c.revision}/${c.scenario}`,
        { type: 'http', url: c.url }
      ])
    ),
    cells
  };
}

/** A single process without a store, at the default idle TTL. */
const IN_MEMORY = { idleMs: DEFAULT_CELL_TTL_MS };

/** The page's text with tags dropped and whitespace folded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

describe('landing page for a newcomer', () => {
  const html = renderLanding('http://x', matrix, IN_MEMORY);
  const said = text(html);

  it('says what this is and what a cell is before the matrix', () => {
    const matrixAt = html.indexOf('<h2 id=matrix>');
    expect(matrixAt).toBeGreaterThan(0);
    for (const id of ['start', 'score', 'trust', 'retention']) {
      const at = html.indexOf(`<h2 id=${id}>`);
      expect(at, id).toBeGreaterThan(0);
      expect(at, id).toBeLessThan(matrixAt);
    }
    expect(said).toContain(
      'This server tests an MCP client that you point at it by hand'
    );
    expect(said).toContain(
      'Each cell of the matrix below is one scenario at one specification revision, with its own MCP URL.'
    );
  });

  it('gives the five-minute path: new run, composite, per-client config, steps, results', () => {
    expect(html).toContain('<a href="/s">Start a new run</a>');
    expect(said).toContain('One URL for several scenarios');
    expect(said).toContain('Each auth scenario needs a URL of its own.');
    expect(said).toContain(
      'VS Code, Codex, Goose and any client that reads mcpServers JSON'
    );
    expect(said).toContain('/results/<run-id>');
    expect(said).toContain('Freeze a copy to link to');
    expect(said).toContain('Markdown or plain text');
    // The section names match the run page's headings, which carry anchors.
    const run = renderConfig('http://x', matrix, configFor('run0'));
    expect(run).toContain(
      '<h2 id=composites>One URL for several scenarios</h2>'
    );
    expect(run).toContain('<h2 id=client-config>Paste into your client</h2>');
    expect(said).toContain('Paste into your client');
    for (const client of CLIENTS)
      expect(run).toContain(`<b>${client.label}</b>`);
  });

  it('explains the score from the matrix and every state in one line', () => {
    expect(said).toContain(
      '“X of the M scored cells you can run here pass · N are scored for the revision”'
    );
    for (const r of matrix.revisions) {
      const set = matrix
        .cells()
        .filter((c) => c.revision === r && c.scoring === 'scored');
      const here = set.filter((c) => c.startable).length;
      expect(said).toContain(`${r} scores ${set.length} and can start ${here}`);
    }
    expect(said).toContain(
      'Verdicts come only from what your client actually sent'
    );
    expect(said).toContain(
      'a cell passes only once your client has spoken that cell’s revision there'
    );
    for (const state of [
      'pass',
      'fail',
      'waiting',
      'in progress',
      'incomplete',
      'not tried'
    ]) {
      expect(html).toContain(`">${state}</span></dt><dd>`);
    }
  });

  it('says results are self-reported and not an SDK tier measurement', () => {
    expect(said).toContain(
      'Nothing stops anyone from testing a modified client'
    );
    expect(said).toContain('share a frozen copy’s link');
    expect(said).toContain('These results are not an SDK tier measurement.');
    expect(html).toContain(`href="${REPO_URL}#sdk-tier-assessment"`);
    expect(html).toContain(`href="${REPO_URL}#conformance-requirements"`);
  });

  it('links the repo, each revision’s specification and the issue tracker', () => {
    expect(html).toContain(`href="${REPO_URL}"`);
    expect(html).toContain(`href="${REPO_URL}/issues"`);
    for (const r of matrix.revisions) {
      expect(html).toContain(
        `<a href="https://modelcontextprotocol.io/specification/${r}">${r}</a>`
      );
    }
  });
});

describe('landing page retention', () => {
  const retention = (r: Parameters<typeof renderLanding>[2]) =>
    text(
      renderLanding('http://x', matrix, r).match(
        /<h2 id=retention>.*?<\/p>/s
      )![0]
    );

  it('writes durations in the largest unit that divides them', () => {
    expect(duration(DEFAULT_CELL_TTL_MS)).toBe('5 minutes');
    expect(duration(6 * 3600_000)).toBe('6 hours');
    expect(duration(30 * 24 * 3600_000)).toBe('30 days');
    expect(duration(90 * 60_000)).toBe('90 minutes');
    expect(duration(3600_000)).toBe('1 hour');
    expect(duration(1500)).toBe('1500 ms');
  });

  it('a single process says runs live in memory, for the idle TTL in force', () => {
    const said = retention(IN_MEMORY);
    expect(said).toContain('Anyone with a run’s link can read its results.');
    expect(said).toContain(
      `dropped once the cell has had no request for ${duration(DEFAULT_CELL_TTL_MS)}`
    );
    expect(said).toContain('frozen copies last until the server restarts');
    expect(said).toContain('DELETE /results/<run-id> removes a run');
    expect(retention({ idleMs: 90 * 60_000 })).toContain(
      'no request for 90 minutes'
    );
  });

  it('a deployment with a store states both of its lifetimes and the idle TTL', () => {
    const said = retention({
      idleMs: DEFAULT_CELL_TTL_MS,
      store: { runMs: 2 * 3600_000, snapshotMs: 7 * 24 * 3600_000 }
    });
    expect(said).toContain(
      'recorded traffic is kept for 2 hours from your client’s first request to it'
    );
    expect(said).toContain('A frozen copy is kept for 7 days');
    expect(said).toContain(
      'A cell with no request for 5 minutes leaves memory and is rebuilt from its stored traffic'
    );
    expect(said).not.toContain('in memory only');
    // A store that states no lifetimes invents none.
    const vague = retention({ idleMs: DEFAULT_CELL_TTL_MS, store: {} });
    expect(vague).not.toMatch(/kept for \d/);
    expect(vague).toContain('for as long as it is set to keep it');
  });
});

describe('hosted HTML', () => {
  it('landing shows the static matrix with scoring, startability and steps, no run links', () => {
    const html = renderLanding('http://x', matrix, IN_MEMORY);
    expect(html).toContain('<a href="/s">Start a new run</a>');
    for (const r of matrix.revisions) expect(html).toContain(`<th>${r}</th>`);
    expect(html).toContain('<code>tools_call</code>');
    expect(html).toContain(
      'not startable: needs a separate sign-in server, which this deployment is not set up with'
    );
    expect(html).toContain(
      'n/a <span class=muted>— introduced in 2025-06-18, removed in 2026-07-28'
    );
    expect(html).toContain('steps (2)');
    expect(html).not.toContain('copy config');
    expect(html).not.toContain('href="/s/');
    // Exclusion reasons are request-independent but still escaped.
    expect(html).toContain('excluded &lt;here&gt;');
  });

  it('run page links every startable cell and embeds the config for the copy buttons', () => {
    const config = configFor('run1');
    const html = renderConfig('http://x', matrix, config);
    expect(html).toContain('<a href="/s/run1/2026-07-28/tools_call">open</a>');
    expect(html).toContain(
      '<a href="/results/run1/2026-07-28/tools_call">results</a>'
    );
    expect(html).toContain('data-copy="2026-07-28/tools_call"');
    expect(html).toContain('data-copy="all"');
    expect(html).not.toContain('data-copy="2026-07-28/initialize"'); // n/a
    // Embedded JSON cannot break out of its <script> element.
    expect(html).toContain('<script type="application/json" id="cfg">');
    expect(html).not.toContain('</script>"}');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('navigator.clipboard.writeText');
  });

  it('run page and landing count startable cells per revision, not "at every revision"', () => {
    const config = configFor('run6');
    const per = matrix.revisions
      .map(
        (r) => `${config.cells.filter((c) => c.revision === r).length} at ${r}`
      )
      .join(', ');
    const html = renderConfig('http://x', matrix, config);
    expect(html).toContain(
      `<p>${config.cells.length} startable cells (${per}).`
    );
    expect(html).not.toContain('at every revision');

    const cells = matrix.cells().filter((c) => c.startable);
    const landingPer = matrix.revisions
      .map((r) => `${cells.filter((c) => c.revision === r).length} at ${r}`)
      .join(', ');
    expect(renderLanding('http://x', matrix, IN_MEMORY)).toContain(
      `${cells.length} startable cells (${landingPer}) here.`
    );

    const column = renderConfig(
      'http://x',
      matrix,
      configFor('run7', { revision: '2026-07-28' })
    );
    expect(column).toMatch(
      /<p>\d+ startable cells? at revision <code>2026-07-28<\/code>\./
    );
  });

  it('column page filters to one revision', () => {
    const html = renderConfig(
      'http://x',
      matrix,
      configFor('run2', { revision: '2025-11-25' })
    );
    expect(html).toContain(
      '<th><a href="/s/run2/2025-11-25">2025-11-25</a></th>'
    );
    expect(html).not.toContain('2026-07-28</a></th>');
    expect(html).toContain('href="/s/run2/2025-11-25/initialize"');
  });

  it('cell page shows the endpoint, env and steps with a copy button', () => {
    const html = renderConfig(
      'http://x',
      matrix,
      configFor('run3', { revision: '2026-07-28', scenario: 'tools_call' })
    );
    expect(html).toContain(
      '<pre>http://x/s/run3/2026-07-28/tools_call/mcp</pre>'
    );
    expect(html).toContain(
      'MCP_CONFORMANCE_PROTOCOL_VERSION=&quot;2026-07-28&quot;'
    );
    expect(html).toContain('<h2>Steps</h2>');
    expect(html).toContain('data-copy="2026-07-28/tools_call"');
    expect(html).toContain(
      'href="http://x/results/run3/2026-07-28/tools_call"'
    );
  });

  it('shows each step as a plain line next to the JSON', () => {
    const landing = renderLanding('http://x', matrix, IN_MEMORY);
    expect(landing).toContain(
      '<ol class=steps><li>list the tools</li><li>call add_numbers with a=2 and b=3</li></ol>'
    );

    const html = renderConfig(
      'http://x',
      matrix,
      configFor('run5', {
        revision: '2026-07-28',
        scenario: 'http-custom-headers'
      })
    );
    expect(html).toContain(
      '<li>call test_custom_headers with region=&quot;us-west1&quot;, priority=42, verbose=false'
    );
    // Control characters stay visible, as JSON escapes.
    expect(html).toContain('crlf_val=&quot;line1\\r\\nline2&quot;');
    expect(html).toContain('verbose=null and query=&quot;SELECT 1&quot;</li>');
    // The JSON is still there.
    expect(html).toContain('&quot;op&quot;: &quot;tools/call&quot;');
  });

  it('composite page shows each child scenario with its steps as lines', () => {
    const html = renderComposite({
      runId: 'r',
      revision: '2026-07-28',
      url: 'http://x/s/r/2026-07-28/tools_call+json-schema-ref-no-deref/mcp',
      resultsUrl: 'http://x/results/r/2026-07-28',
      children: [
        {
          scenario: 'tools_call',
          description: 'd',
          resultsUrl: 'http://x/results/r/2026-07-28/tools_call',
          steps: [
            { op: 'tools/list' },
            { op: 'tools/call', name: 'add_numbers', arguments: { a: 5, b: 3 } }
          ]
        },
        {
          scenario: 'no-steps',
          description: 'd',
          resultsUrl: 'http://x/results/r/2026-07-28/no-steps'
        }
      ]
    });
    expect(html).toContain('<li>call add_numbers with a=5 and b=3</li>');
    expect(html).toContain('&quot;op&quot;: &quot;tools/list&quot;');
    expect(html.match(/<ol class=steps>/g)).toHaveLength(1);
  });

  it('offers the bare MCP URL to copy on every cell, cell page and composite', () => {
    const run = renderConfig('http://x', matrix, configFor('run6'));
    expect(run).toContain(
      '<button class=copy data-copy-text="http://x/s/run6/2026-07-28/tools_call/mcp">copy URL</button>'
    );
    expect(run).toMatch(
      /data-copy-text="http:\/\/x\/s\/run6\/2026-07-28\/tools_call\+[^"]*\/mcp">copy URL/
    );
    const cell = renderConfig(
      'http://x',
      matrix,
      configFor('run6', { revision: '2026-07-28', scenario: 'tools_call' })
    );
    expect(cell).toContain(
      'data-copy-text="http://x/s/run6/2026-07-28/tools_call/mcp">copy URL'
    );
    const composite = renderComposite({
      runId: 'r',
      revision: '2026-07-28',
      url: 'http://x/s/r/2026-07-28/a+b/mcp',
      resultsUrl: 'http://x/results/r/2026-07-28',
      children: []
    });
    expect(composite).toContain(
      'data-copy-text="http://x/s/r/2026-07-28/a+b/mcp">copy URL'
    );
    // The copy script handles literal text, and runs on the composite page.
    expect(composite).toContain("b.getAttribute('data-copy-text')");
  });

  it('offers ready-to-paste config for VS Code, Codex and Goose on cell and composite pages', () => {
    const cell = renderConfig(
      'http://x',
      matrix,
      configFor('run8', { revision: '2026-07-28', scenario: 'tools_call' })
    );
    const url = 'http://x/s/run8/2026-07-28/tools_call/mcp';
    expect(cell).toContain('Paste into your client');
    // Each block is shown and has its own copy button with the same text.
    expect(cell).toContain(
      `data-copy-text="${esc(`{\n  "servers": {\n    "c9e-2026-07-28-tools_call": {\n      "type": "http",\n      "url": "${url}"\n    }\n  }\n}`)}"`
    );
    expect(cell).toContain(
      esc(`[mcp_servers.c9e-2026-07-28-tools_call]\nurl = "${url}"`)
    );
    expect(cell).toContain(
      esc(
        `  c9e-2026-07-28-tools_call:\n    enabled: true\n    type: streamable_http`
      )
    );
    // The existing mcpServers-plus-env button stays.
    expect(cell).toContain('data-copy="2026-07-28/tools_call">copy config');

    const composite = renderComposite({
      runId: 'r',
      revision: '2026-07-28',
      url: 'http://x/s/r/2026-07-28/tools_call+http-standard-headers/mcp',
      resultsUrl: 'http://x/results/r/2026-07-28',
      children: [
        { scenario: 'tools_call', description: 'd', resultsUrl: 'u' },
        { scenario: 'http-standard-headers', description: 'd', resultsUrl: 'u' }
      ]
    });
    expect(composite).toContain(
      esc(
        `[mcp_servers.c9e-2026-07-28-tools_call-http-standard-headers]\nurl = "http://x/s/r/2026-07-28/tools_call+http-standard-headers/mcp"`
      )
    );
  });

  it('offers one block per client on the run page: the ready-made composites and every auth cell', () => {
    const withAuth = buildMatrix({ auxOrigins: { as: 'http://as' } });
    const cells = withAuth
      .cells()
      .filter((c) => c.startable)
      .map((c) => ({
        scenario: c.scenario,
        revision: c.revision,
        url: `http://x/s/run9/${c.revision}/${c.scenario}/mcp`,
        resultsUrl: '',
        scoring: c.scoring,
        env: {
          MCP_CONFORMANCE_SCENARIO: c.scenario,
          MCP_CONFORMANCE_PROTOCOL_VERSION: c.revision
        }
      }));
    const run = renderConfig('http://x', withAuth, {
      runId: 'run9',
      resultsUrl: 'http://x/results/run9',
      mcpServers: {},
      cells
    });
    // Per client a starter block and the full one; the full one is longer.
    const blocksWith = (marker: string) =>
      [...run.matchAll(/data-copy-text="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((t) => t.includes(marker))
        .sort((a, b) => a.length - b.length);
    const [gooseStarter, goose] = blocksWith('type: streamable_http');
    const [codexStarter, codex] = blocksWith('[mcp_servers.');
    // Pasted under the file's own `extensions:` key: no key of its own.
    expect(goose).not.toMatch(/^extensions:/m);
    expect(run).toContain(
      'Paste under extensions: in ~/.config/goose/config.yaml.'
    );
    // Auth cells arrive switched off, the composites on.
    expect(goose).toContain(
      '  c9e-2026-07-28-auth-resource-mismatch:\n    enabled: false'
    );
    expect(goose).toContain('  c9e-2026-07-28-composite:\n    enabled: true');
    expect(codex).toContain(
      '[mcp_servers.c9e-2026-07-28-auth-resource-mismatch]\nurl = &quot;http://x/s/run9/2026-07-28/auth/resource-mismatch/mcp&quot;\nenabled = false'
    );
    // The starter: the composites and metadata-default per revision, on.
    for (const starter of [gooseStarter, codexStarter]) {
      expect(starter).toContain('c9e-2025-11-25-composite');
      expect(starter).toContain('c9e-2026-07-28-auth-metadata-default');
      expect(starter).not.toContain('auth-resource-mismatch');
      expect(starter).not.toContain('enabled: false');
      expect(starter).not.toContain('enabled = false');
    }
    // Copilot CLI has its own block (its entries need `tools`).
    expect(run).toContain('<b>Copilot CLI</b>');
    const auth = cells.filter((c) => c.scenario.startsWith('auth/'));
    expect(auth.length).toBeGreaterThan(10);
    for (const name of [
      'c9e-2025-11-25-composite',
      'c9e-2026-07-28-composite',
      ...auth.map((c) => `c9e-${c.revision}-${c.scenario.replace('/', '-')}`)
    ]) {
      expect(goose).toContain(`  ${name}:\n`);
    }
    // Only those: a cell a composite covers is not listed again.
    expect(goose).not.toContain('c9e-2026-07-28-tools_call:');
    expect(run).toContain('data-copy-text="{\n  &quot;servers&quot;');
  });

  it('renders the markdown in scenario descriptions instead of showing it raw', () => {
    expect(prose('**PRM:** `/.well-known/x` <b>\nnext', true)).toBe(
      '<b>PRM:</b> <code>/.well-known/x</code> &lt;b&gt;<br>next'
    );
    const landing = renderLanding('http://x', matrix, IN_MEMORY);
    expect(landing).toContain('<b>PRM:</b>');
    expect(landing).not.toContain('**PRM:**');
  });

  it('tells a person driving a client by hand what to expect', () => {
    const cellPage = (scenario: string, context?: Record<string, unknown>) => {
      const config = configFor('run7', {
        revision: '2026-07-28',
        scenario: 'tools_call'
      });
      const cell = {
        ...config.cells[0],
        scenario,
        steps: undefined,
        env: {
          ...config.cells[0].env,
          MCP_CONFORMANCE_SCENARIO: scenario,
          MCP_CONFORMANCE_CONTEXT: JSON.stringify({
            name: scenario,
            ...context
          })
        }
      };
      return renderConfig('http://x', matrix, {
        ...config,
        scenario,
        cells: [cell]
      });
    };
    expect(cellPage('request-metadata')).toContain(
      'first request is refused once on purpose'
    );
    expect(cellPage('http-standard-headers')).toContain(
      'a kind it never sends is skipped, not failed'
    );
    const preReg = cellPage('auth/pre-registration', {
      client_id: 'pre-registered-client',
      client_secret: 'pre-registered-secret'
    });
    expect(preReg).toContain('<h2>Credentials</h2>');
    expect(preReg).toContain(
      '<code>pre-registered-secret</code> <button class=copy data-copy-text="pre-registered-secret">copy</button>'
    );
    expect(preReg).toContain('approves at once, with no account');
    expect(cellPage('auth/client-credentials-basic')).toContain(
      'there is no sign-in page'
    );
    expect(cellPage('tools_call')).not.toContain('<h2>Credentials</h2>');
  });

  it('escapes request-derived values', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = renderConfig('http://x', matrix, configFor(evil));
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img');
    expect(
      renderMatrixTable(matrix, { origin: 'http://x', runId: evil })
    ).not.toContain('<img');
    expect(jsonForScript({ a: '</script><b>' })).toBe(
      '{"a":"\\u003c/script>\\u003cb>"}'
    );
  });

  it('escapes traffic-derived values on the run report', async () => {
    // A client name and a failure message are whatever the client sent.
    const evil = '"><img src=x onerror=alert(1)>';
    const id = 'r/2025-11-25/tools_call';
    const report = await buildReport(matrix, 'r', undefined, {
      listCells: async () => [
        { runId: 'r', revision: '2025-11-25', scenarioName: 'tools_call' }
      ],
      results: async (cell) =>
        cell === id
          ? {
              checks: [
                {
                  id: 'c',
                  name: 'c',
                  description: '',
                  status: 'FAILURE',
                  timestamp: '',
                  errorMessage: evil
                },
                identityCheck(
                  identityOf({ name: evil, protocolVersion: '2025-11-25' })
                )
              ],
              recorded: 1
            }
          : undefined,
      resultsUrl: (ref) => `http://x/results/${cellId(ref)}`
    });
    expect(report.causes[0].text).toBe(evil); // on the row and as a cause
    const html = renderReport(matrix, report, {
      markdown: evil,
      text: evil,
      liveUrl: 'http://x/results/r'
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('groups the run report: problems, then not tried with a URL to copy, then passes; unavailable folded at the bottom', async () => {
    const rev = '2025-11-25';
    const logs = new Map<string, 'SUCCESS' | 'FAILURE'>([
      [`r/${rev}/initialize`, 'SUCCESS'],
      [`r/${rev}/tools_call`, 'FAILURE']
    ]);
    const judged = await buildReport(matrix, 'r', undefined, {
      listCells: async () =>
        Array.from(logs.keys()).map((id) => {
          const [runId, revision, ...rest] = id.split('/');
          return {
            runId,
            revision: revision as typeof rev,
            scenarioName: rest.join('/')
          };
        }),
      results: async (id) => {
        const status = logs.get(id);
        return status
          ? {
              checks: [
                { id: 'c', name: 'c', description: '', status, timestamp: '' }
              ],
              recorded: 1
            }
          : undefined;
      },
      resultsUrl: (ref) => `http://x/results/${cellId(ref)}`
    });
    const report = withNotTriedHints(
      judged,
      matrix,
      (ref) => `http://x/s/${cellId(ref)}`,
      describeStep
    );
    const html = renderReport(matrix, report, {
      markdown: '',
      text: '',
      liveUrl: 'http://x/results/r'
    });
    expect(html).toContain('<h2>Cells by revision</h2>');
    expect(html).not.toContain('Cells the client reached');
    // The score leads with what the person could run, scored total kept.
    const col = report.columns[0];
    expect(html).toContain(scoreText(col));
    expect(scoreText(col)).toContain(
      `${col.scored.passed} of the ${col.scored.startable} scored cells you can run here pass · ` +
        `${col.scored.total} are scored for ${col.revision}`
    );

    const table = html.slice(
      html.indexOf('<table class=reached>'),
      html.indexOf('</table>', html.indexOf('<table class=reached>'))
    );
    const at = (s: string) => {
      const i = table.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    // At the revision the client reached: fail, not tried, then passes.
    const head = at(
      `Not tried yet (${col.counts['not-tried']}): your client never connected to these`
    );
    expect(at(`/${rev}/tools_call"><code>tools_call</code>`)).toBeLessThan(
      head
    );
    expect(head).toBeLessThan(at('Passed (1)'));
    expect(at('Passed (1)')).toBeLessThan(
      at(`/${rev}/initialize"><code>initialize</code>`)
    );
    expect(table).toContain('Common reasons: the client was not given');
    // Each not-tried cell: what the client must do, and its URL to copy.
    expect(table).toContain(
      `data-copy-text="http://x/s/r/${rev}/elicitation-sep1034-client-defaults/mcp"`
    );
    expect(table).toContain(
      'the client must connect, then list the tools, then call test_client_elicitation_defaults'
    );
    // A revision the client reached nothing at: its cells folded.
    expect(table).toMatch(
      /<details><summary>Not tried yet \(\d+\): your client never connected to any cell at this revision<\/summary>/
    );
    // Cells this deployment cannot start are in no list above.
    expect(table).not.toContain('sse-retry');
    expect(table).not.toContain('auth/metadata-default');

    const every = html.slice(
      html.indexOf('<h2>Every cell</h2>'),
      html.indexOf('<details class=section')
    );
    expect(every).toContain('<code>tools_call</code>');
    expect(every).not.toContain('<code>sse-retry</code>');
    expect(every).not.toContain('<code>auth/metadata-default</code>');
    expect(every).not.toContain('not startable');

    // At the bottom, folded: one line per scenario with its reason.
    const bottom = html.slice(html.indexOf('<details class=section'));
    expect(html.indexOf('<details class=section')).toBeGreaterThan(
      html.indexOf('<h2>Every cell</h2>')
    );
    expect(bottom).toMatch(
      /^<details class=section id=unavailable><summary>Unavailable on this deployment \(\d+\)<\/summary>/
    );
    expect(bottom).toContain(
      `<li><code>sse-retry</code> <span class=muted>${rev}</span> — excluded &lt;here&gt;</li>`
    );
    expect(bottom).toMatch(
      /<li><code>auth\/metadata-default<\/code> <span class=muted>[^<]*<\/span> — needs a separate sign-in server, which this deployment is not set up with<\/li>/
    );
  });

  it('keeps a live report and a cell page current, never a frozen copy', async () => {
    const report = await buildReport(matrix, 'r', undefined, {
      listCells: async () => [],
      results: async () => undefined,
      resultsUrl: () => ''
    });
    const opts = { markdown: '', text: '', liveUrl: 'http://x/results/r' };
    const live = renderReport(matrix, report, opts);
    expect(live).toContain('Updates every 10 s while this tab is open');
    expect(live).toContain('id=live-toggle');
    expect(live).toContain('document.hidden');
    const frozen = renderReport(
      matrix,
      { ...report, snapshotId: 's', frozenAt: report.generatedAt },
      opts
    );
    expect(frozen).not.toContain('live-toggle');
    expect(frozen).not.toContain('Updates every');
    const cell = renderResults(
      { runId: 'r', revision: '2026-07-28', scenarioName: 'tools_call' },
      []
    );
    expect(cell).toContain('Updates every 10 s while this tab is open');
  });
});
