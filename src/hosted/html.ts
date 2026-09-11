/**
 * HTML for the hosted server: the matrix (landing and run/column/cell config
 * pages) and the per-cell check report. Everything interpolated goes through
 * escapeHtml(); JSON embedded for the copy buttons goes through jsonForScript().
 */

import { ConformanceCheck, CheckStatus } from '../types';
import type { HostedMatrix, MatrixCell } from './matrix';
import type { CellConfig, RunConfig } from './server';
import type { CellRef } from './session';
import type { CellReport, RunReport, Verdict } from './report';
import type { ClientIdentity } from './identity';

const VERDICT_STYLE: Record<Verdict, string> = {
  pass: 'background:#d1fae5;color:#065f46',
  fail: 'background:#fee2e2;color:#991b1b',
  incomplete: 'background:#f3f4f6;color:#6b7280',
  'n/a': 'background:#f3f4f6;color:#9ca3af'
};

const STATUS_STYLE: Record<CheckStatus, string> = {
  SUCCESS: 'background:#d1fae5;color:#065f46',
  FAILURE: 'background:#fee2e2;color:#991b1b',
  WARNING: 'background:#fef3c7;color:#92400e',
  SKIPPED: 'background:#e5e7eb;color:#374151',
  INFO: 'background:#dbeafe;color:#1e40af'
};

const SCORING_STYLE: Record<MatrixCell['scoring'], string> = {
  scored: 'background:#dbeafe;color:#1e40af',
  not_scored: 'background:#ede9fe;color:#5b21b6',
  unlisted: 'background:#f3f4f6;color:#374151',
  'n/a': 'background:#f3f4f6;color:#9ca3af'
};

const SCORING_LABEL: Record<MatrixCell['scoring'], string> = {
  scored: 'scored',
  not_scored: 'not scored',
  unlisted: 'not in the requirement set',
  'n/a': 'n/a'
};

const css = `
  body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:1100px;
    margin:2rem auto;padding:0 1rem;color:#111}
  code,pre{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:#f6f8fa;padding:.75rem;border-radius:6px;overflow:auto;margin:.4rem 0}
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;
    font-size:11px;font-weight:600;white-space:nowrap}
  .check{border:1px solid #e5e7eb;border-radius:6px;padding:.75rem;
    margin:.5rem 0}
  .check h3{margin:0 0 .25rem;font-size:14px}
  details>summary{cursor:pointer;color:#6b7280;font-size:12px}
  table{border-collapse:collapse;width:100%}
  td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eee;
    vertical-align:top}
  td.cell{min-width:14rem}
  td.na{color:#9ca3af}
  .muted{color:#6b7280;font-size:12px}
  .crumbs{color:#6b7280;margin:0 0 1rem}
  .crumbs a{margin-right:.25rem}
  .actions{margin:.25rem 0}
  button.copy{font:inherit;font-size:11px;padding:1px 8px;border:1px solid #d1d5db;
    border-radius:10px;background:#fff;cursor:pointer}
  button.copy:hover{background:#f3f4f6}
  a{color:#2563eb}
  h1 code,h2 code{font-size:inherit}
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

/** JSON safe inside a <script> element: `<` can't start `</script>`. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset=utf-8>
<title>${esc(title)}</title><style>${css}</style>
${body}`;
}

function scoringPill(cell: MatrixCell): string {
  return `<span class=pill style="${SCORING_STYLE[cell.scoring]}" title="${esc(
    cell.reason ?? ''
  )}">${SCORING_LABEL[cell.scoring]}</span>`;
}

function stepsDetails(cell: Pick<MatrixCell, 'steps'>): string {
  if (!cell.steps) return '';
  return (
    `<details><summary>steps (${cell.steps.length})</summary>` +
    `<pre>${esc(JSON.stringify(cell.steps, null, 1))}</pre></details>`
  );
}

interface TableOptions {
  origin: string;
  /** When set, startable cells link to their page and results. */
  runId?: string;
  /** Column filter. */
  revision?: string;
  /** Row filter. */
  scenario?: string;
}

/**
 * The matrix as a table: scenarios down, revisions across. Without a run id
 * it is the static overview (what is scored, what can start, what steps a
 * cell wants); with one, every startable cell links into that run.
 */
export function renderMatrixTable(
  matrix: HostedMatrix,
  opts: TableOptions
): string {
  const revisions = matrix.revisions.filter(
    (r) => opts.revision === undefined || r === opts.revision
  );
  const rows = matrix.rows.filter(
    (r) => opts.scenario === undefined || r.scenario === opts.scenario
  );
  const head =
    `<tr><th>scenario</th>` +
    revisions
      .map((r) =>
        opts.runId
          ? `<th><a href="/s/${esc(opts.runId)}/${esc(r)}">${esc(r)}</a></th>`
          : `<th>${esc(r)}</th>`
      )
      .join('') +
    '</tr>';
  const body = rows
    .map((row) => {
      const cells = row.cells
        .filter((c) => revisions.includes(c.revision))
        .map((c) => renderMatrixCell(c, opts))
        .join('');
      return (
        `<tr><td><code>${esc(row.scenario)}</code>` +
        `<div class=muted>${esc(row.description)}</div></td>${cells}</tr>`
      );
    })
    .join('');
  return `<table>${head}${body}</table>`;
}

function renderMatrixCell(cell: MatrixCell, opts: TableOptions): string {
  if (cell.scoring === 'n/a') {
    return `<td class="cell na">n/a <span class=muted>— ${esc(cell.reason ?? '')}</span></td>`;
  }
  const key = `${cell.revision}/${cell.scenario}`;
  let lines = `<div>${scoringPill(cell)}</div>`;
  if (cell.scoring !== 'scored' && cell.reason) {
    lines += `<div class=muted>${esc(cell.reason)}</div>`;
  }
  if (!cell.startable) {
    lines += `<div class=muted>not startable: ${esc(cell.startReason ?? '')}</div>`;
  } else if (opts.runId) {
    const base = `/s/${esc(opts.runId)}/${esc(key)}`;
    lines +=
      `<div class=actions><a href="${base}">open</a> · ` +
      `<a href="/results/${esc(opts.runId)}/${esc(key)}">results</a> · ` +
      `<button class=copy data-copy="${esc(key)}">copy config</button></div>`;
  }
  lines += stepsDetails(cell);
  return `<td class=cell>${lines}</td>`;
}

export function renderLanding(origin: string, matrix: HostedMatrix): string {
  const startable = matrix.cells().filter((c) => c.startable).length;
  return page(
    'MCP Conformance — hosted',
    `<h1>MCP Conformance — hosted</h1>
<p>Client conformance as a service. One run exercises the whole matrix below:
every client scenario at every specification revision that ships a
requirement set (${matrix.revisions.map((r) => `<code>${esc(r)}</code>`).join(', ')}).
Each cell is its own MCP server speaking that revision's wire, at
<code>${esc(origin)}/s/&lt;run-id&gt;/&lt;revision&gt;/&lt;scenario&gt;</code>
(plus the scenario's MCP path); results mirror the shape under
<code>/results/&lt;run-id&gt;</code>.</p>
<p><b><a href="/s">Start a run</a></b> — mints a run id and shows this matrix
with a link and a copyable config per cell. Cells are created lazily on first
request; cells that show <i>steps</i> tell a generic client what to do
(<code>MCP_CONFORMANCE_CONTEXT.steps</code>).</p>
<p class=muted>${matrix.rows.length} scenarios × ${matrix.revisions.length} revisions,
${startable} startable cells here. <a href="/scenarios">JSON</a>.</p>
${renderMatrixTable(matrix, { origin })}`
  );
}

function crumbs(config: RunConfig): string {
  const parts = [
    `<a href="/">matrix</a>`,
    `<a href="/s/${esc(config.runId)}">run <code>${esc(config.runId)}</code></a>`
  ];
  if (config.revision) {
    parts.push(
      `<a href="/s/${esc(config.runId)}/${esc(config.revision)}">${esc(config.revision)}</a>`
    );
  }
  if (config.scenario) parts.push(`<code>${esc(config.scenario)}</code>`);
  return `<p class=crumbs>${parts.join(' › ')} · <a href="${esc(
    config.resultsUrl
  )}">results</a></p>`;
}

/**
 * The copy-to-clipboard script. The config is embedded as JSON in a
 * <script type="application/json"> element; buttons name what to copy:
 * `all` (the mcpServers map for this scope), or `<rev>/<scenario>` (that
 * cell's server entry plus its env).
 */
const copyScript = `<script>
(function(){
  var el=document.getElementById('cfg');if(!el)return;
  var cfg=JSON.parse(el.textContent);
  function text(what){
    if(what==='all')return JSON.stringify({mcpServers:cfg.mcpServers},null,2);
    var cell=cfg.cells.find(function(c){return c.revision+'/'+c.scenario===what});
    if(!cell)return '';
    var servers={};servers[what]=cfg.mcpServers[what];
    return JSON.stringify({mcpServers:servers,env:cell.env},null,2);
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('button[data-copy]');if(!b)return;
    var t=text(b.getAttribute('data-copy'));
    navigator.clipboard.writeText(t).then(function(){
      var was=b.textContent;b.textContent='copied';
      setTimeout(function(){b.textContent=was},1200);
    });
  });
})();
</script>`;

function envPre(cell: CellConfig): string {
  const lines = Object.entries(cell.env).map(
    ([k, v]) => `${k}=${JSON.stringify(v)}`
  );
  return `<pre>${esc(lines.join('\n'))}</pre>`;
}

/** Config page for a run, a column or a cell. */
export function renderConfig(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): string {
  const title = config.scenario
    ? `${config.scenario} @ ${config.revision} — run ${config.runId}`
    : config.revision
      ? `run ${config.runId} @ ${config.revision}`
      : `run ${config.runId}`;
  const embedded = `<script type="application/json" id="cfg">${jsonForScript(config)}</script>`;

  let body: string;
  if (config.scenario && config.revision) {
    const cell = config.cells[0];
    const key = `${config.revision}/${config.scenario}`;
    const row = matrix.rows.find((r) => r.scenario === config.scenario);
    body = `<h1><code>${esc(config.scenario)}</code> <small>@ ${esc(
      config.revision
    )}</small></h1>
${crumbs(config)}
<p>${esc(row?.description ?? '')}</p>
<p>${scoringPill(matrix.cell(config.scenario, config.revision)!)}${
      cell.reason ? ` <span class=muted>${esc(cell.reason)}</span>` : ''
    }</p>
<h2>MCP endpoint</h2>
<pre>${esc(cell.url)}</pre>
<div class=actions><button class=copy data-copy="${esc(key)}">copy config</button>
<span class=muted>— an <code>mcpServers</code> entry plus the env the CLI runner would set</span></div>
<h2>Environment</h2>
${envPre(cell)}
${
  cell.steps
    ? `<h2>Steps</h2><p class=muted>What a generic client should do here (also in <code>MCP_CONFORMANCE_CONTEXT.steps</code>).</p><pre>${esc(
        JSON.stringify(cell.steps, null, 1)
      )}</pre>`
    : ''
}
<p><a href="${esc(cell.resultsUrl)}">results for this cell</a></p>`;
  } else {
    const scope = config.revision
      ? `revision <code>${esc(config.revision)}</code>`
      : 'every revision';
    body = `<h1>run <code>${esc(config.runId)}</code>${
      config.revision ? ` <small>@ ${esc(config.revision)}</small>` : ''
    }</h1>
${crumbs(config)}
<p>${config.cells.length} startable cell${config.cells.length === 1 ? '' : 's'} at ${scope}.
Point your client at a cell's MCP URL (open it for the env the CLI runner
would set), then read the <a href="${esc(config.resultsUrl)}">results</a>.
<button class=copy data-copy="all">copy mcpServers for all ${config.cells.length}</button></p>
${renderMatrixTable(matrix, {
  origin,
  runId: config.runId,
  revision: config.revision
})}`;
  }
  return page(title, `${body}\n${embedded}\n${copyScript}`);
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
  return page(
    `${ref.scenarioName} @ ${ref.revision} — ${ref.runId}`,
    `<h1><code>${esc(ref.scenarioName)}</code> <small>@ ${esc(ref.revision)}</small></h1>
<p class=crumbs><a href="/results/${esc(ref.runId)}">run <code>${esc(
      ref.runId
    )}</code></a> › <a href="/results/${esc(ref.runId)}/${esc(
      ref.revision
    )}">${esc(ref.revision)}</a> › <code>${esc(ref.scenarioName)}</code> · <a href="/s/${esc(
      ref.runId
    )}/${esc(ref.revision)}/${esc(ref.scenarioName)}">config</a></p>
<p>${passed} passed, ${failed} failed, ${checks.length} total</p>${items}`
  );
}

function identityLine(identities: ClientIdentity[]): string {
  if (!identities.length) return '<span class=muted>no client seen yet</span>';
  return identities
    .map((i) => {
      const who = i.name
        ? `<b>${esc(i.name)}</b>${i.version ? ` ${esc(i.version)}` : ''}`
        : '<i>unnamed client</i>';
      const proto = i.protocolVersion
        ? ` · protocol <code>${esc(i.protocolVersion)}</code>`
        : '';
      const ua = i.userAgent
        ? ` <span class=muted title="${esc(i.userAgent)}">(${esc(
            i.userAgent.length > 40
              ? i.userAgent.slice(0, 40) + '…'
              : i.userAgent
          )})</span>`
        : '';
      return `${who}${proto}${ua}`;
    })
    .join('<br>');
}

function verdictCell(cell: CellReport): string {
  if (cell.verdict === 'n/a') {
    return `<td class="cell na">n/a <span class=muted>— ${esc(cell.reason ?? '')}</span></td>`;
  }
  const pill = `<span class=pill style="${VERDICT_STYLE[cell.verdict]}">${cell.verdict}</span>`;
  let lines = `<div>${pill} ${scoringPillFor(cell)}</div>`;
  if (cell.summary) {
    const s = cell.summary;
    lines += `<div class=muted><a href="${esc(cell.resultsUrl)}">${s.passed} passed, ${s.failed} failed${
      s.warnings ? `, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}` : ''
    }, ${s.total} total</a></div>`;
  } else if (!cell.startable) {
    lines += `<div class=muted>not startable: ${esc(cell.startReason ?? '')}</div>`;
  } else {
    lines += `<div class=muted><a href="${esc(cell.resultsUrl)}">nothing recorded</a></div>`;
  }
  return `<td class=cell>${lines}</td>`;
}

function scoringPillFor(cell: CellReport): string {
  return `<span class=pill style="${SCORING_STYLE[cell.scoring]}" title="${esc(
    cell.reason ?? ''
  )}">${SCORING_LABEL[cell.scoring]}</span>`;
}

/** Report page for a run or one of its columns. */
export function renderReport(
  origin: string,
  matrix: HostedMatrix,
  report: RunReport
): string {
  const title = report.revision
    ? `results — run ${report.runId} @ ${report.revision}`
    : `results — run ${report.runId}`;
  const head =
    `<tr><th>scenario</th>` +
    report.columns
      .map(
        (col) =>
          `<th><a href="/results/${esc(report.runId)}/${esc(col.revision)}">${esc(
            col.revision
          )}</a><div class=muted>scored ${col.scored.passed} of ${col.scored.total}</div>` +
          `<div class=muted>${identityLine(col.identities)}</div></th>`
      )
      .join('') +
    '</tr>';
  const rows = matrix.rows
    .map((row) => {
      const cells = report.columns
        .map((col) => col.cells.find((c) => c.scenario === row.scenario)!)
        .map(verdictCell)
        .join('');
      return `<tr><td><code>${esc(row.scenario)}</code></td>${cells}</tr>`;
    })
    .join('');
  const notScored = report.columns
    .map((col) => {
      if (!col.notScored.length) return '';
      const items = col.notScored
        .map(
          (c) =>
            `<li><code>${esc(c.scenario)}</code> <span class=pill style="${
              VERDICT_STYLE[c.verdict]
            }">${c.verdict}</span> <span class=muted>${esc(
              SCORING_LABEL[c.scoring]
            )}${c.reason ? ` — ${esc(c.reason)}` : ''}</span> · <a href="${esc(
              c.resultsUrl
            )}">checks</a></li>`
        )
        .join('');
      return `<h3>${esc(col.revision)}: run but not scored</h3><ul>${items}</ul>`;
    })
    .join('');
  const crumbs = [
    `<a href="/">matrix</a>`,
    `<a href="/results/${esc(report.runId)}">run <code>${esc(report.runId)}</code></a>`
  ];
  if (report.revision) crumbs.push(`<code>${esc(report.revision)}</code>`);
  crumbs.push(
    `<a href="/s/${esc(report.runId)}${
      report.revision ? `/${esc(report.revision)}` : ''
    }">config</a>`
  );
  return page(
    title,
    `<h1>results — run <code>${esc(report.runId)}</code>${
      report.revision ? ` <small>@ ${esc(report.revision)}</small>` : ''
    }</h1>
<p class=crumbs>${crumbs.join(' › ')}</p>
<p>Client: ${identityLine(report.identities)}</p>
<p class=muted>A cell passes when checks were recorded and none is a FAILURE;
<i>scored X of N</i> counts passes among the cells the revision's requirement
set scores and this deployment can start. Not-scored and unlisted cells are
listed below the table. <a href="${esc(origin)}/results/${esc(report.runId)}${
      report.revision ? `/${esc(report.revision)}` : ''
    }?format=json">JSON</a>.</p>
<table>${head}${rows}</table>
${notScored}`
  );
}
