import { describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import {
  jsonForScript,
  renderComposite,
  renderConfig,
  renderLanding,
  renderMatrixTable
} from './html';
import type { RunConfig } from './server';

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
});
