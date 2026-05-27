import { ConformanceCheck, CheckStatus } from '../types';

const STATUS_STYLE: Record<CheckStatus, string> = {
  SUCCESS: 'background:#d1fae5;color:#065f46',
  FAILURE: 'background:#fee2e2;color:#991b1b',
  WARNING: 'background:#fef3c7;color:#92400e',
  SKIPPED: 'background:#e5e7eb;color:#374151',
  INFO: 'background:#dbeafe;color:#1e40af'
};

const css = `
  body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:960px;
    margin:2rem auto;padding:0 1rem;color:#111}
  code,pre{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:#f6f8fa;padding:.75rem;border-radius:6px;overflow:auto}
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;
    font-size:11px;font-weight:600}
  .check{border:1px solid #e5e7eb;border-radius:6px;padding:.75rem;
    margin:.5rem 0}
  .check h3{margin:0 0 .25rem;font-size:14px}
  details>summary{cursor:pointer;color:#6b7280;font-size:12px}
  table{border-collapse:collapse;width:100%}
  td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eee}
  a{color:#2563eb}
`;

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
  );
}

export function renderLanding(origin: string, scenarios: string[]): string {
  const rows = scenarios
    .map(
      (n) =>
        `<tr><td><code>${esc(n)}</code></td>` +
        `<td><code>${esc(origin)}/s/${esc(n)}</code></td></tr>`
    )
    .join('');
  return `<!doctype html><meta charset=utf-8>
<title>MCP Conformance — hosted</title><style>${css}</style>
<h1>MCP Conformance — hosted</h1>
<p>Point your MCP client at one of the scenario URLs below. The first request
creates a session; the response carries an <code>mcp-session-id</code> header
and a <code>Link: &lt;.../results/ID&gt;; rel="conformance-results"</code>
header. Fetch that URL (or append <code>.html</code>) for your checks.</p>
<p>This server is also an MCP server at <code>${esc(origin)}/mcp</code> with
<code>list_scenarios</code> / <code>start_session</code> /
<code>get_results</code> tools.</p>
<h2>Scenarios (${scenarios.length})</h2>
<table><tr><th>name</th><th>MCP URL</th></tr>${rows}</table>
<h2>Example</h2>
<pre>$ npx @modelcontextprotocol/inspector ${esc(origin)}/s/initialize
# then open ${esc(origin)}/results/&lt;mcp-session-id&gt;.html</pre>`;
}

export function renderResults(
  scenario: string,
  sessionId: string,
  checks: ConformanceCheck[]
): string {
  const items = checks
    .map((c) => {
      const pill = `<span class=pill style="${STATUS_STYLE[c.status]}">${c.status}</span>`;
      const refs = (c.specReferences ?? [])
        .map((r) =>
          r.url
            ? `<a href="${esc(r.url)}">${esc(r.id)}</a>`
            : `<span>${esc(r.id)}</span>`
        )
        .join(' · ');
      const details =
        c.details || c.errorMessage
          ? `<details><summary>details</summary><pre>${esc(
              JSON.stringify(
                { errorMessage: c.errorMessage, ...c.details },
                null,
                2
              )
            )}</pre></details>`
          : '';
      return `<div class=check><h3>${pill} <code>${esc(c.id)}</code> — ${esc(
        c.name
      )}</h3><p>${esc(c.description)}</p><p>${refs}</p>${details}</div>`;
    })
    .join('');
  const passed = checks.filter((c) => c.status === 'SUCCESS').length;
  const failed = checks.filter((c) => c.status === 'FAILURE').length;
  return `<!doctype html><meta charset=utf-8>
<title>${esc(scenario)} — ${sessionId}</title><style>${css}</style>
<h1><code>${esc(scenario)}</code></h1>
<p>session <code>${esc(sessionId)}</code> — ${passed} passed, ${failed} failed,
${checks.length} total</p>${items}`;
}
