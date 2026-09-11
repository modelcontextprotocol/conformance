import { ConformanceCheck, CheckStatus } from '../types';
import type { HostedMatrix } from './matrix';
import type { RunConfig } from './server';
import type { CellRef } from './session';

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

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );
}
const esc = escapeHtml;

export function renderLanding(origin: string, matrix: HostedMatrix): string {
  const head = matrix.revisions.map((r) => `<th>${esc(r)}</th>`).join('');
  const rows = matrix.rows
    .map(
      (row) =>
        `<tr><td><code>${esc(row.scenario)}</code></td>` +
        row.cells
          .map(
            (c) =>
              `<td>${esc(c.scoring)}${
                c.startable
                  ? ''
                  : ` <small>(${esc(c.startReason ?? c.reason ?? '')})</small>`
              }</td>`
          )
          .join('') +
        '</tr>'
    )
    .join('');
  return `<!doctype html><meta charset=utf-8>
<title>MCP Conformance — hosted</title><style>${css}</style>
<h1>MCP Conformance — hosted</h1>
<p>One run exercises every client scenario at every specification revision
that ships a requirement set. <a href="/s">Start a run</a> to get a run id,
then point your client at each cell's URL
(<code>${esc(origin)}/s/&lt;run-id&gt;/&lt;revision&gt;/&lt;scenario&gt;</code>)
and read <code>/results/&lt;run-id&gt;</code>.</p>
<table><tr><th>scenario</th>${head}</tr>${rows}</table>`;
}

export function renderConfig(
  origin: string,
  _matrix: HostedMatrix,
  config: RunConfig
): string {
  return `<!doctype html><meta charset=utf-8>
<title>run ${esc(config.runId)}</title><style>${css}</style>
<h1>run <code>${esc(config.runId)}</code></h1>
<p><a href="${esc(config.resultsUrl)}">results</a> · <a href="${esc(origin)}/">matrix</a></p>
<pre>${esc(JSON.stringify(config, null, 2))}</pre>`;
}

export function renderResults(
  ref: CellRef,
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
<title>${esc(ref.scenarioName)} @ ${esc(ref.revision)} — ${esc(ref.runId)}</title><style>${css}</style>
<h1><code>${esc(ref.scenarioName)}</code> <small>@ ${esc(ref.revision)}</small></h1>
<p>run <a href="/results/${esc(ref.runId)}"><code>${esc(ref.runId)}</code></a> — ${passed} passed, ${failed} failed,
${checks.length} total</p>${items}`;
}
