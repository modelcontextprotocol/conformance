import { describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import {
  escapeHtml as esc,
  jsonForScript,
  prose,
  renderComposite,
  renderConfig,
  renderLanding,
  renderMatrixTable,
  renderReport
} from './html';
import type { RunConfig } from './server';
import { buildReport } from './report';
import { cellId } from './session';
import { identityCheck, identityOf } from './identity';

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

describe('hosted HTML', () => {
  it('landing shows the static matrix with scoring, startability and steps, no run links', () => {
    const html = renderLanding('http://x', matrix);
    expect(html).toContain('<a href="/s">Start a run</a>');
    for (const r of matrix.revisions) expect(html).toContain(`<th>${r}</th>`);
    expect(html).toContain('<code>tools_call</code>');
    expect(html).toContain('not startable: needs relay origin(s) [as]');
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
    const landing = renderLanding('http://x', matrix);
    expect(landing).toContain(
      '<ol class=steps><li>list the tools</li><li>call add_numbers with a=5 and b=3</li></ol>'
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
    const goose = run.match(/data-copy-text="(extensions:[^"]*)"/)![1];
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
    const landing = renderLanding('http://x', matrix);
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
});
