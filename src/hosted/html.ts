/**
 * HTML for the hosted server: the matrix (landing and run/column/cell config
 * pages) and the per-cell check report. Everything interpolated goes through
 * escapeHtml(); JSON embedded for the copy buttons goes through jsonForScript().
 */

import { ConformanceCheck, CheckStatus } from '../types';
import {
  MCP_PATH,
  startableCount,
  type HostedMatrix,
  type MatrixCell
} from './matrix';
import { buildCommit, buildText, type BuildInfo } from './build';
import type { CellConfig, CellStatus, RunConfig } from './server';
import type { CellRef } from './session';
import {
  groupColumn,
  incompleteNote,
  NO_SIGN_IN,
  summarize,
  unavailableScenarios,
  type CellReport,
  type CellState,
  type ColumnReport,
  type RunReport
} from './report';
import type { ClientIdentity } from './identity';
import type { Cause } from './findings';
import type { SnapshotInfo, StoreRetention } from './store';
import type { ShownCheck } from './shown';
import {
  BY_LABEL,
  REACHED,
  STATE_LABEL,
  causeNumbers,
  countsLine,
  countsText,
  NO_FINDINGS,
  NOT_TRIED_WHY,
  notTriedHeading,
  passedHeading,
  scoreText,
  showsCounts,
  UNAVAILABLE_HEADING,
  UNAVAILABLE_WHY,
  stopNote,
  utcMinute,
  waitingFor,
  type Unmet
} from './markdown';
import { describeStep, type Step } from '../steps';
import {
  COMPOSITE_SEPARATOR,
  DEFAULT_COMPOSITES,
  type CompositeView
} from './composite';
import {
  CLIENTS,
  clientConfig,
  compositeName,
  serverName,
  type ClientInfo,
  type ServerEntry
} from './client-config';

const STATE_STYLE: Record<CellState, string> = {
  pass: 'background:#d1fae5;color:#065f46',
  fail: 'background:#fee2e2;color:#991b1b',
  waiting: 'background:#e0e7ff;color:#3730a3',
  stopped: 'background:#fef3c7;color:#92400e',
  'in-progress': 'background:#dbeafe;color:#1e40af',
  incomplete: 'background:#fef3c7;color:#92400e',
  'not-tried': 'background:#f3f4f6;color:#6b7280',
  'not-startable': 'background:#f3f4f6;color:#9ca3af',
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
  ol.steps{margin:.4rem 0;padding-left:1.5rem}
  ol.steps li{margin:.15rem 0}
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
  .note{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;
    padding:.5rem .75rem}
  form.inline{display:inline}
  ol.causes li{margin:.5rem 0}
  tr.group td{background:#f9fafb;font-weight:600;color:#374151}
  td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
  td.what div{margin:.1rem 0}
  .client{margin:.6rem 0}
  ol.start li{margin:.3rem 0}
  dl.states{display:grid;grid-template-columns:max-content 1fr;gap:.2rem .75rem;
    margin:.4rem 0}
  dl.states dd{margin:0}
  tr.nottried td{background:#fffbeb}
  tr.nottried td.head{font-weight:600;color:#92400e}
  tr.nottried details>summary{font-size:14px;font-weight:600;color:#92400e}
  ul.nottried{margin:.4rem 0;padding-left:1.25rem}
  ul.nottried li{margin:.3rem 0}
  tr.sub td{font-weight:600;color:#374151}
  details.section{margin:1.5rem 0}
  details.section>summary{font-size:1.2em;font-weight:600;color:#111}
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

/**
 * A scenario description as HTML: escaped, with the little markdown the
 * descriptions use (**bold**, `code`) rendered, and line breaks kept when
 * `breaks` is set (on a page about one scenario, not in the matrix).
 */
export function prose(text: string, breaks = false): string {
  const html = esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return breaks ? html.replace(/\n/g, '<br>') : html;
}

/** What a person driving a client by hand should know before starting. */
const HAND_NOTES: Record<string, string> = {
  'request-metadata':
    'Your client’s first request is refused once on purpose, with an ' +
    '“Unsupported protocol version” error naming 2026-07-28, to check that ' +
    'the client retries. A correct client retries at once; if yours shows an ' +
    'error instead, retry or reconnect.',
  'http-standard-headers':
    'Each kind of request your client sends is checked for the headers it ' +
    'must carry; a kind it never sends is skipped, not failed. To cover more, ' +
    'list the tools and call one, list and read the resources, and list the ' +
    'prompts and get one.'
};

function handNote(scenario: string): string {
  const note = HAND_NOTES[scenario];
  return note ? `<p class=note>${esc(note)}</p>` : '';
}

/**
 * Plain steps for an auth cell, which has no generic-client steps: what a
 * person does with a client they drive by hand.
 */
function authSteps(scenario: string): string {
  if (!scenario.startsWith('auth/')) return '';
  const lines = [
    'add the MCP URL to your client and connect',
    NO_SIGN_IN.test(scenario)
      ? 'there is no sign-in page: your client gets its token itself, with the credentials this scenario gives it'
      : 'approve the sign-in when your client opens it — the test authorization server approves at once, with no account',
    'once connected, list the tools'
  ];
  return (
    `<h2>Steps</h2><p class=muted>What to do with a client you drive by hand.</p>` +
    `<ol class=steps>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`
  );
}

const CREDENTIAL_KEYS = ['client_id', 'client_secret'] as const;

/** Credentials the scenario gives the client, as fields a person can copy. */
function credentials(cell: CellConfig): string {
  const raw = cell.env.MCP_CONFORMANCE_CONTEXT;
  if (!raw) return '';
  let context: Record<string, unknown>;
  try {
    context = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return '';
  }
  const rows = CREDENTIAL_KEYS.flatMap((key) => {
    const value = context[key];
    if (typeof value !== 'string' || !value) return [];
    return [
      `<tr><th><code>${key}</code></th><td><code>${esc(value)}</code> ` +
        `<button class=copy data-copy-text="${esc(value)}">copy</button></td></tr>`
    ];
  });
  if (!rows.length) return '';
  return (
    `<h2>Credentials</h2><p class=muted>Enter these in your client. ` +
    `A scripted client reads them from <code>MCP_CONFORMANCE_CONTEXT</code>.</p>` +
    `<table>${rows.join('')}</table>`
  );
}

/**
 * The page, with a footer naming the server build when `build` is given:
 * the commit linked to its source, and when it was deployed. A report
 * passes its own (a frozen copy's is the build that froze it); `null` says
 * the report was stored before builds were recorded.
 */
function page(title: string, body: string, build?: BuildInfo | null): string {
  return `<!doctype html><meta charset=utf-8>
<title>${esc(title)}</title><style>${css}</style>
${body}${build === undefined ? '' : buildFooter(build)}`;
}

function buildFooter(build: BuildInfo | null): string {
  const text = buildText(build ?? undefined);
  const commit = build ? buildCommit(build) : undefined;
  const shown = commit
    ? esc(text).replace(
        esc(build!.build),
        `<a href="${REPO_URL}/commit/${commit}"><code>${esc(build!.build)}</code></a>`
      )
    : esc(text);
  return `\n<footer class=muted>Server ${shown}.</footer>`;
}

function scoringPill(cell: MatrixCell): string {
  return `<span class=pill style="${SCORING_STYLE[cell.scoring]}" title="${esc(
    cell.reason ?? ''
  )}">${SCORING_LABEL[cell.scoring]}</span>`;
}

/** One plain line per step: what a person makes a hand-driven client do. */
function stepLines(steps: readonly Step[]): string {
  const items = steps.map((s) => `<li>${esc(describeStep(s))}</li>`);
  return `<ol class=steps>${items.join('')}</ol>`;
}

/** The same steps as the JSON a generic client reads. */
function stepsJson(steps: readonly Step[]): string {
  return `<pre>${esc(JSON.stringify(steps, null, 1))}</pre>`;
}

/** Collapsed, for a matrix cell. */
function stepsDetails(cell: Pick<MatrixCell, 'steps'>): string {
  if (!cell.steps) return '';
  return (
    `<details><summary>steps (${cell.steps.length})</summary>` +
    `${stepLines(cell.steps)}${stepsJson(cell.steps)}</details>`
  );
}

/** Open, for a page about one scenario: the lines, the JSON folded below. */
function stepsOpen(steps: readonly Step[]): string {
  return (
    stepLines(steps) +
    `<details><summary>as JSON (<code>MCP_CONFORMANCE_CONTEXT.steps</code>)</summary>` +
    `${stepsJson(steps)}</details>`
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
        `<div class=muted>${prose(row.description)}</div></td>${cells}</tr>`
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
    const url = `${opts.origin}/s/${opts.runId}/${key}${MCP_PATH}`;
    lines +=
      `<div class=actions><a href="${base}">open</a> · ` +
      `<a href="/results/${esc(opts.runId)}/${esc(key)}">results</a> · ` +
      `<button class=copy data-copy-text="${esc(url)}">copy URL</button> ` +
      `<button class=copy data-copy="${esc(key)}">copy config</button></div>`;
  }
  lines += stepsDetails(cell);
  return `<td class=cell>${lines}</td>`;
}

export const REPO_URL = 'https://github.com/modelcontextprotocol/conformance';

/** A revision's specification on modelcontextprotocol.io. */
export function specUrl(revision: string): string {
  return `https://modelcontextprotocol.io/specification/${revision}`;
}

/** What the landing page says about how long this deployment keeps a run. */
export interface LandingRetention {
  /** SessionManager.ttlMs: a cell with no request for this long leaves memory. */
  idleMs: number;
  /**
   * Present when runs persist to a store (a serverless deployment), with
   * the store's own lifetimes when it states them (RunStore.retention).
   */
  store?: Partial<StoreRetention>;
}

/** "5 minutes", "6 hours", "30 days": the largest unit that divides `ms`. */
export function duration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1_000, 'second']
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return `${ms} ms`;
}

/** Each state a report shows, in one line (see CellState). */
const STATE_MEANING: [CellState, string][] = [
  [
    'pass',
    'the client did what the scenario tests, and nothing it sent broke a check'
  ],
  [
    'fail',
    'something the client sent broke a check; the cell leads with the reason'
  ],
  [
    'waiting',
    'the only failures are steps the scenario still expects, such as a sign-in or a form not finished yet'
  ],
  [
    'stopped',
    'waiting, but the client has sent nothing for a few minutes and no sign-in or form is open: it most likely stopped, so re-run it'
  ],
  [
    'in-progress',
    'the client reached the cell but has not yet done anything the scenario tests'
  ],
  [
    'incomplete',
    'the client reached the cell and stopped: it spoke only another revision, was turned away, and did not retry'
  ],
  ['not-tried', 'nothing has reached the cell yet']
];

function retentionHtml(r: LandingRetention): string {
  const idle = duration(r.idleMs);
  let kept: string;
  if (!r.store) {
    kept =
      `This server keeps runs in memory only: a cell’s recorded traffic is dropped ` +
      `once the cell has had no request for ${idle}, and frozen copies last until ` +
      `the server restarts.`;
  } else {
    const { runMs, snapshotMs } = r.store;
    kept =
      (runMs !== undefined
        ? `A cell’s recorded traffic is kept for ${duration(runMs)} from your ` +
          `client’s first request to it; after that the cell reads as not tried. `
        : `A cell’s recorded traffic is kept in this deployment’s store for as long as it is set to keep it. `) +
      (snapshotMs !== undefined
        ? `A frozen copy is kept for ${duration(snapshotMs)} from when it was ` +
          `frozen, so freeze one to keep a result. `
        : '') +
      `A cell with no request for ${idle} leaves memory and is rebuilt from ` +
      `its stored traffic on its next request, which loses nothing.`;
  }
  return (
    `<h2 id=retention>How long results last</h2>` +
    `<p>Anyone with a run’s link can read its results. ${kept} ` +
    `<code>DELETE /results/&lt;run-id&gt;</code> removes a run and its frozen copies at once.</p>`
  );
}

/**
 * The landing page: what this is, how to test a client in five minutes,
 * what a score means, what a result is not, how long results last, then
 * the static matrix.
 */
export function renderLanding(
  origin: string,
  matrix: HostedMatrix,
  retention: LandingRetention,
  build?: BuildInfo
): string {
  const cells = matrix.cells();
  const startableCells = cells.filter((c) => c.startable);
  const scored = matrix.revisions
    .map((r) => {
      const set = cells.filter(
        (c) => c.revision === r && c.scoring === 'scored'
      );
      const here = set.filter((c) => c.startable).length;
      return `<code>${esc(r)}</code> scores ${set.length} and can start ${here}`;
    })
    .join('; ');
  const states = STATE_MEANING.map(
    ([state, meaning]) => `<dt>${statePill(state)}</dt><dd>${esc(meaning)}</dd>`
  ).join('');
  const specs = matrix.revisions
    .map((r) => `<a href="${esc(specUrl(r))}">${esc(r)}</a>`)
    .join(' · ');
  return page(
    'MCP Conformance — hosted',
    `<h1>MCP Conformance — hosted</h1>
<p>This server tests an MCP <b>client</b> that you point at it by hand, such as an
IDE, a desktop agent or a deployed client that a script cannot drive. Each cell
of the matrix below is one scenario at one specification revision, with its own
MCP URL.</p>

<h2 id=start>Test your client in five minutes</h2>
<ol class=start>
<li><b><a href="/s">Start a new run</a>.</b> The run page holds every URL for that
run; keep to that one run.</li>
<li>On the run page, <b>One URL for several scenarios</b> gives one URL per revision
that carries most of its scenarios without a sign-in. Each auth scenario needs a
URL of its own. <b>Paste into your client</b> puts all of them in one block per
client, for VS Code, Codex, Goose and any client that reads <code>mcpServers</code> JSON.</li>
<li>Make your client do what each cell’s steps say, usually list the tools and call
one. For an auth cell, connect and approve the sign-in: the test authorization
server approves at once, with no account.</li>
<li>Read the results at <code>/results/&lt;run-id&gt;</code>, linked from the run
page, which updates itself while it is open. <i>Freeze a copy to link to</i> gives a
link that never changes, and you can copy the report as Markdown or plain text for
an issue or a chat.</li>
</ol>
<p class=muted>Some clients speak 2026-07-28 only behind an opt-in (Codex CLI:
<code>codex --enable mcp_2026_07_28</code>), and many pick up new servers only when
they start or open a new chat.</p>

<h2 id=score>What the score means</h2>
<p>A report column reads “X of the M scored cells you can run here pass · N are scored
for the revision”: X is how many have passed, M is how many of the N cells the
revision’s frozen <a href="${REPO_URL}#conformance-requirements">requirement set</a>
scores this deployment can start, and N is the set’s count, whether or not each
can start here: ${scored}. Cells marked <i>not scored</i> or <i>not in the requirement set</i> run and report
but never count. Verdicts come only from what your client actually sent to this
server, and a cell passes only once your client has spoken that cell’s revision
there: a finished sign-in or an older handshake is not enough.</p>
<dl class=states>${states}</dl>

<h2 id=trust>Self-reported, and not a tier</h2>
<p>Results describe what your client did against this server. Nothing stops
anyone from testing a modified client, so to offer a result as evidence, share a
frozen copy’s link: it is dated, and anyone can check it by pointing the same client
build at a new run. Everything sent to a run’s URLs counts as your client’s, so
debug with other tools on a separate run.</p>
<p>These results are not an SDK tier measurement. SDK tiers (SEP-1730) are assessed
with <code>tier-check</code>, whose conformance pass rates come from the CLI runner
driving the SDK’s own conformance client and server
(<a href="${REPO_URL}#sdk-tier-assessment">SDK Tier Assessment</a>). This server is
for clients that cannot be scripted that way.</p>

${retentionHtml(retention)}

<p class=muted>Source, CLI and docs: <a href="${REPO_URL}">modelcontextprotocol/conformance</a>.
Specification: ${specs}. A check looks wrong or a scenario misbehaves?
<a href="${REPO_URL}/issues">Open an issue</a> with the frozen Markdown report.</p>

<h2 id=matrix>The matrix</h2>
<p class=muted>${matrix.rows.length} scenarios × ${matrix.revisions.length} revisions,
${esc(startableCount(startableCells, matrix.revisions))} here. A cell’s MCP URL is
<code>${esc(origin)}/s/&lt;run-id&gt;/&lt;revision&gt;/&lt;scenario&gt;${MCP_PATH}</code>, and
its results sit at the same path under <code>/results</code>. Cells that show
<i>steps</i> tell a generic client what to do
(<code>MCP_CONFORMANCE_CONTEXT.steps</code>). <a href="/scenarios">JSON</a>.</p>
${renderMatrixTable(matrix, { origin })}`,
    build
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
 * `data-copy="all"` (the mcpServers map for this scope), `data-copy=
 * "<rev>/<scenario>"` (that cell's server entry plus its env), or
 * `data-copy-text` (that literal text, such as a bare MCP URL).
 */
const copyScript = `<script>
(function(){
  var el=document.getElementById('cfg');
  var cfg=el?JSON.parse(el.textContent):null;
  function text(what){
    if(!cfg)return '';
    if(what==='all')return JSON.stringify({mcpServers:cfg.mcpServers},null,2);
    var cell=cfg.cells.find(function(c){return c.revision+'/'+c.scenario===what});
    if(!cell)return '';
    var servers={};servers[what]=cfg.mcpServers[what];
    return JSON.stringify({mcpServers:servers,env:cell.env},null,2);
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('button[data-copy],button[data-copy-text]');if(!b)return;
    var t=b.hasAttribute('data-copy-text')?b.getAttribute('data-copy-text'):text(b.getAttribute('data-copy'));
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

/**
 * Ready-to-paste config per client (see ./client-config.ts), each with a
 * copy button and a line on adding it to a file that already has servers.
 * With `starter` (the run page, whose full list is long): the starter block
 * open, the full one folded.
 */
function clientBlocks(
  entries: readonly ServerEntry[],
  intro: string,
  starter?: readonly ServerEntry[]
): string {
  if (!entries.length) return '';
  const block = (
    client: ClientInfo,
    list: readonly ServerEntry[],
    label: string
  ) => {
    const text = clientConfig(client.kind, list);
    return `<button class=copy data-copy-text="${esc(text)}">${esc(label)}</button><pre>${esc(text)}</pre>`;
  };
  const blocks = CLIENTS.map((client) => {
    const head =
      `<div class=client><b>${esc(client.label)}</b> <span class=muted>${esc(client.where)}</span>` +
      `<p class=muted>${esc(client.merge)}</p>`;
    if (!starter) return `${head}${block(client, entries, 'copy')}</div>`;
    const all = `all ${entries.length} entries${
      client.switchesOff ? ', auth cells switched off' : ''
    }`;
    return (
      `${head}${block(client, starter, 'copy starter')}` +
      `<details><summary>${esc(all)}</summary>${block(client, entries, 'copy all')}</details></div>`
    );
  });
  return `<h2 id=client-config>Paste into your client</h2><p class=muted>${intro}</p>${blocks.join('')}`;
}

/** Config page for a run, a column or a cell. */
export function renderConfig(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig,
  build?: BuildInfo
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
<p>${prose(row?.description ?? '', true)}</p>
${handNote(config.scenario)}
<p>${scoringPill(matrix.cell(config.scenario, config.revision)!)}${
      cell.reason ? ` <span class=muted>${esc(cell.reason)}</span>` : ''
    }</p>
<h2>MCP endpoint</h2>
<pre>${esc(cell.url)}</pre>
<div class=actions><button class=copy data-copy-text="${esc(cell.url)}">copy URL</button>
<button class=copy data-copy="${esc(key)}">copy config</button>
<span class=muted>— the URL alone, or an <code>mcpServers</code> entry plus the env the CLI runner would set</span></div>
${clientBlocks(
  [{ name: serverName(cell.revision, cell.scenario), url: cell.url }],
  'This cell as each client’s config file wants it.'
)}
${credentials(cell)}
${
  cell.steps
    ? `<h2>Steps</h2><p class=muted>What to make the client do here. A generic client reads the same steps from <code>MCP_CONFORMANCE_CONTEXT.steps</code>.</p>${stepsOpen(
        cell.steps
      )}`
    : authSteps(config.scenario)
}
<h2>Environment</h2>
${envPre(cell)}
<p><a href="${esc(cell.resultsUrl)}">results for this cell</a></p>`;
  } else {
    // Per revision when the page covers several: a total summed over
    // revisions read as "N at every revision" is taken for N per revision.
    const count = config.revision
      ? `${startableCount(config.cells, [config.revision])} at revision <code>${esc(config.revision)}</code>`
      : esc(startableCount(config.cells, matrix.revisions));
    body = `<h1>run <code>${esc(config.runId)}</code>${
      config.revision ? ` <small>@ ${esc(config.revision)}</small>` : ''
    }</h1>
${crumbs(config)}
<p>${count}.
Point your client at a cell's MCP URL (open it for the env the CLI runner
would set), then read the <a href="${esc(config.resultsUrl)}">results</a>.
<button class=copy data-copy="all">copy mcpServers for all ${config.cells.length}</button></p>
${compositeLinks(origin, matrix, config)}
${runClientBlocks(origin, matrix, config)}
${renderMatrixTable(matrix, {
  origin,
  runId: config.runId,
  revision: config.revision
})}`;
  }
  return page(title, `${body}\n${embedded}\n${copyScript}`, build);
}

/** The run page's ready-made composites, per revision in scope. */
function readyComposites(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): { revision: string; children: string[]; cell: string; url: string }[] {
  const revisions = config.revision ? [config.revision] : matrix.revisions;
  return revisions.flatMap((revision) => {
    const children = (DEFAULT_COMPOSITES[revision] ?? []).filter(
      (name) => matrix.cell(name, revision)?.startable
    );
    if (children.length < 2) return [];
    const cell = `${origin}/s/${config.runId}/${revision}/${children.join(COMPOSITE_SEPARATOR)}`;
    return [{ revision, children, cell, url: `${cell}${MCP_PATH}` }];
  });
}

/** The auth cell the run page's starter block carries, per revision. */
const STARTER_AUTH = 'auth/metadata-default';

/**
 * The entries of the run page's client blocks. The full one covers every
 * startable cell of the run once: the ready-made composites, then each cell
 * no composite carries (one that cannot share a URL, such as
 * `request-metadata`), then every auth cell, switched off where the client
 * can say so, since each starts a sign-in when the client connects (and
 * `codex mcp list` fetches the metadata of every one that is on). The
 * starter: the composites and one auth cell per revision, on.
 */
export function runClientEntries(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): { starter: ServerEntry[]; all: ServerEntry[] } {
  const ready = readyComposites(origin, matrix, config);
  const composites = ready.map((c) => ({
    name: compositeName(c.revision, c.children),
    url: c.url
  }));
  const covered = new Set(
    ready.flatMap((c) => c.children.map((child) => `${c.revision}/${child}`))
  );
  const isAuth = (c: CellConfig) => c.scenario.startsWith('auth/');
  const entry = (c: CellConfig) => ({
    name: serverName(c.revision, c.scenario),
    url: c.url
  });
  const auth = config.cells.filter(isAuth);
  const alone = config.cells.filter(
    (c) => !isAuth(c) && !covered.has(`${c.revision}/${c.scenario}`)
  );
  return {
    starter: [
      ...composites,
      ...auth.filter((c) => c.scenario === STARTER_AUTH).map(entry)
    ],
    all: [
      ...composites,
      ...alone.map(entry),
      ...auth.map((c) => ({ ...entry(c), enabled: false }))
    ]
  };
}

/** The run page's client blocks (see runClientEntries()). */
function runClientBlocks(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): string {
  const { starter, all } = runClientEntries(origin, matrix, config);
  return clientBlocks(
    all,
    `The starter block is the ready-made composites and <code>${STARTER_AUTH}</code> at each revision. ` +
      'The full block covers every startable cell once: the composites, each cell that cannot share a URL ' +
      '(such as <code>request-metadata</code>), and every auth cell, switched off where the client can say so: ' +
      'switch on the ones you want to test.',
    starter
  );
}

/**
 * The run page's ready-made composites: per revision, one MCP URL carrying
 * several scenarios, for a client that is configured by hand.
 */
function compositeLinks(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): string {
  const items = readyComposites(origin, matrix, config).map(
    ({ revision, children, cell, url }) =>
      `<li><code>${esc(revision)}</code>: <a href="${esc(cell)}">${children.length} scenarios</a> at <code>${esc(url)}</code> ` +
      `<button class=copy data-copy-text="${esc(url)}">copy URL</button></li>`
  );
  if (!items.length) return '';
  return `<h2 id=composites>One URL for several scenarios</h2>
<p>For a client you configure by hand, give it one of these instead of a URL
per scenario. Each scenario still records and scores in its own cell below.</p>
<ul>${items.join('')}</ul>`;
}

/**
 * A composite's page: the one URL to give the client, then what to make the
 * client do for each scenario behind it, and where each result lands.
 */
export function renderComposite(view: CompositeView): string {
  const children = view.children
    .map(
      (c) => `<div class=check><h3><code>${esc(c.scenario)}</code></h3>
<p>${prose(c.description, true)}</p>${handNote(c.scenario)}${c.steps ? stepsOpen(c.steps) : ''}
<p><a href="${esc(c.resultsUrl)}">results for this scenario</a></p></div>`
    )
    .join('\n');
  return page(
    `composite @ ${view.revision} — run ${view.runId}`,
    `<h1>${view.children.length} scenarios, one URL <small>@ ${esc(view.revision)}</small></h1>
<p class=crumbs><a href="/s/${esc(view.runId)}">run ${esc(view.runId)}</a></p>
<p>Give the client under test this MCP URL. Each scenario below still records
and scores on its own, so its results page reads exactly as if the client had
been pointed at it directly.</p>
<h2>MCP endpoint</h2>
<pre>${esc(view.url)}</pre>
<div class=actions><button class=copy data-copy-text="${esc(view.url)}">copy URL</button></div>
${clientBlocks(
  [
    {
      name: compositeName(
        view.revision,
        view.children.map((c) => c.scenario)
      ),
      url: view.url
    }
  ],
  'This composite as each client’s config file wants it.'
)}
<h2>Scenarios behind it</h2>
${children}
<p><a href="${esc(view.resultsUrl)}">results for the whole run at ${esc(view.revision)}</a></p>
${copyScript}`
  );
}

/** How often a live page checks for news, in seconds. */
const LIVE_SECONDS = 10;

/**
 * What keeps a live page (the run report, a cell's results) current while
 * a person drives a client: every LIVE_SECONDS, while the tab is visible,
 * the page fetches itself and swaps in its #live part if that changed,
 * keeping open whatever was open. A note says so and has a stop button. A
 * frozen copy never has it.
 */
const liveNote =
  `<p class=muted id=live-note>Updates every ${LIVE_SECONDS} s while this tab is open ` +
  `<button class=copy id=live-toggle type=button>stop</button> <span id=live-status></span></p>`;

const liveScript = `<script>
(function(){
  var box=document.getElementById('live'),btn=document.getElementById('live-toggle'),
      st=document.getElementById('live-status'),on=true;
  if(!box||!btn)return;
  btn.addEventListener('click',function(){
    on=!on;btn.textContent=on?'stop':'resume';st.textContent=on?'':'stopped';
  });
  function tick(){
    if(!on||document.hidden)return;
    st.textContent='updating…';
    fetch(location.href,{headers:{accept:'text/html'},cache:'no-store'})
      .then(function(r){return r.text()})
      .then(function(t){
        var next=new DOMParser().parseFromString(t,'text/html').getElementById('live');
        if(next&&next.innerHTML!==box.innerHTML){
          var open=[].map.call(box.querySelectorAll('details[open]>summary'),function(x){return x.textContent});
          box.innerHTML=next.innerHTML;
          [].forEach.call(box.querySelectorAll('details>summary'),function(x){
            if(open.indexOf(x.textContent)>=0)x.parentNode.open=true;
          });
        }
        st.textContent='';
      })
      .catch(function(){st.textContent='could not update';});
  }
  setInterval(tick,${LIVE_SECONDS * 1000});
})();
</script>`;

/** One line saying where the cell stands, for the cell results page. */
function statusLine(status: CellStatus): string {
  const pill = statePill(status.state);
  const scoring = `<span class=pill style="${SCORING_STYLE[status.scoring]}">${SCORING_LABEL[status.scoring]}</span>`;
  let note = '';
  if (status.verdict === 'n/a') {
    note = `the scenario does not apply to this revision: ${esc(status.reason ?? '')}`;
  } else if (status.startable === false) {
    note = `not startable here: ${esc(status.startReason ?? '')}`;
  } else if (status.verdict === 'incomplete') {
    note = esc(status.note ?? incompleteNote([]));
  } else if (status.state === 'waiting' || status.state === 'stopped') {
    note = esc(status.note ?? '');
  } else if (status.reason) {
    note = esc(status.reason);
  }
  return `<p>${pill} ${scoring}${note ? ` <span class=muted>— ${note}</span>` : ''}</p>`;
}

/** Style of a "not seen" pill: the scenario's expectation, not a failure. */
const NOT_SEEN_STYLE = STATUS_STYLE.SKIPPED;

/**
 * What a check is about, under its reason: its name and description, each
 * said once, and not the "Expected Check Missing" placeholder some auth
 * scenarios give an expectation nothing met.
 */
function about(c: ConformanceCheck): string {
  const parts = [c.name, c.description].filter(
    (p, i, all) =>
      p && !p.startsWith('Expected Check Missing') && all.indexOf(p) === i
  );
  return parts.map((p) => esc(p)).join(': ');
}

export function renderResults(
  ref: CellRef,
  checks: ShownCheck[],
  status?: CellStatus,
  build?: BuildInfo
): string {
  const items = checks
    .map((c) => {
      const pill =
        (c.notSeen
          ? `<span class=pill style="${NOT_SEEN_STYLE}" title="the scenario’s own expectation, not seen in the client’s traffic">not seen</span>`
          : `<span class=pill style="${STATUS_STYLE[c.status]}">${c.status}</span>`) +
        (c.repeats
          ? ` <span class=muted>recorded ${c.repeats} times</span>`
          : '');
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
      // A failure or warning leads with what went wrong (see ./shown.ts);
      // which check it is and what that check is about follow underneath.
      const said = about(c);
      const head = c.reason
        ? `<h3>${pill} ${esc(c.reason)}</h3><p><code>${esc(c.id)}</code>${
            said ? ` — ${said}` : ''
          }</p>`
        : `<h3>${pill} <code>${esc(c.id)}</code> — ${esc(
            c.name
          )}</h3><p>${esc(c.description)}</p>`;
      return `<div class=check>${head}${refs ? `<p>${refs}</p>` : ''}${details}</div>`;
    })
    .join('');
  // Skipped checks are said apart: nothing was checked, so they are
  // neither a pass nor a failure.
  const counts = summarize(checks);
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
${liveNote}<div id=live>${status ? statusLine(status) : ''}<p>${esc(countsLine(counts))}${
      counts.skipped
        ? ` <span class=muted>· ${counts.skipped} skipped: the client did nothing they check</span>`
        : ''
    }</p>${items}</div>${liveScript}`,
    build
  );
}

function identityLine(identities: ClientIdentity[]): string {
  if (!identities.length) return '<span class=muted>no client seen yet</span>';
  return identities
    .map((i) => {
      const who = i.name
        ? `<b>${esc(i.name)}</b>${i.version ? ` ${esc(i.version)}` : ''}`
        : '<i>unnamed client</i>';
      const proto = i.protocolVersions.length
        ? ` · protocol ${i.protocolVersions
            .map((v) => `<code>${esc(v)}</code>`)
            .join(', ')}`
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

function statePill(state: CellState): string {
  return `<span class=pill style="${STATE_STYLE[state]}">${STATE_LABEL[state]}</span>`;
}

function verdictCell(cell: CellReport): string {
  if (cell.verdict === 'n/a') {
    return `<td class="cell na">n/a <span class=muted>— ${esc(cell.reason ?? '')}</span></td>`;
  }
  let lines = `<div>${statePill(cell.state)} ${scoringPillFor(cell)}</div>`;
  const link = (text: string, title = '') =>
    `<div class=muted><a href="${esc(cell.resultsUrl)}"${
      title ? ` title="${esc(title)}"` : ''
    }>${text}</a></div>`;
  if (cell.state === 'in-progress') {
    // Its failures are only what the scenario still expects (see
    // incompleteNote()): counting them here would read as a verdict.
    lines += link('reached, nothing tested yet', cell.note);
  } else if (cell.state === 'incomplete') {
    lines += link('reached, stopped short', cell.note);
  } else if (cell.summary) {
    lines += link(countsLine(cell.summary), cell.note);
  } else if (!cell.startable) {
    lines += `<div class=muted><a href="#unavailable">unavailable on this deployment</a></div>`;
  } else {
    lines += link('not tried');
  }
  return `<td class=cell>${lines}</td>`;
}

/** "(cause 2)" when a finding's or a cell's cause covers other cells too. */
function causeLink(
  key: string | undefined,
  causes: ReadonlyMap<string, Cause>,
  numbers: ReadonlyMap<string, number>
): string {
  const cause = key ? causes.get(key) : undefined;
  if (!cause || cause.cells.length < 2) return '';
  const n = numbers.get(cause.key)!;
  return ` <a href="#cause-${n}" class=muted>cause ${n}</a>`;
}

/** "the flow has not reached <code>a</code>, …", or the reason. */
function unmetHtml(u: Unmet): string {
  return u.checks
    ? `the flow has not reached ${u.checks.map((c) => `<code>${esc(c)}</code>`).join(', ')}`
    : esc(u.reason);
}

/** A reached cell's "what happened": its findings, or why it stopped. */
function happenedHtml(
  cell: CellReport,
  causes: ReadonlyMap<string, Cause>,
  numbers: ReadonlyMap<string, number>
): string {
  const findings = cell.findings ?? [];
  if (cell.state === 'in-progress') {
    return findings.length
      ? `<div class=muted>waiting for:</div>${waitingFor(cell)
          .map((u) => `<div>${unmetHtml(u)}</div>`)
          .join('')}`
      : `<div class=muted>${esc(cell.note ?? '')}</div>`;
  }
  if (cell.state === 'incomplete') {
    return `<div>${esc(stopNote(cell))}${causeLink(cell.cause, causes, numbers)}</div>`;
  }
  // A waiting cell's own expectations are what it waits for; anything the
  // client did (a warning) is listed as on any other row.
  const waiting = cell.state === 'waiting' || cell.state === 'stopped';
  const lines = findings
    .filter((f) => !waiting || f.by === 'client')
    .map(
      (f) =>
        `<div><span class=pill style="${STATUS_STYLE[f.status]}" title="${
          f.by === 'client'
            ? 'seen in the client’s traffic'
            : 'the scenario’s own expectation, not seen yet'
        }">${BY_LABEL[f.by]}</span> <code>${esc(f.check)}</code> ${esc(
          f.reason
        )}${causeLink(f.cause, causes, numbers)}</div>`
    );
  if (waiting) {
    lines.unshift(
      `<div class=muted>${esc(cell.note ?? '')}; not seen yet:</div>` +
        waitingFor(cell)
          .map((u) => `<div>${unmetHtml(u)}</div>`)
          .join('')
    );
  }
  return lines.length
    ? lines.join('')
    : `<span class=muted>${NO_FINDINGS}</span>`;
}

/** What a not-tried cell wants: the client's steps, and its URL to copy. */
function notTriedHtml(cell: CellReport): string {
  const hint = cell.hint
    ? `<div>the client must ${esc(cell.hint)}</div>`
    : '<div class=muted>nothing reached this cell</div>';
  const url = cell.mcpUrl
    ? `<div class=actions><button class=copy data-copy-text="${esc(cell.mcpUrl)}">copy URL</button> ` +
      `<code class=muted>${esc(cell.mcpUrl)}</code></div>`
    : '';
  return hint + url;
}

/**
 * One revision's rows: what needs a look (fail, waiting, in progress,
 * incomplete), then what the client has not tried, then what passed. Cells
 * this deployment cannot start are not here (see unavailableSection()).
 */
function revisionRows(
  col: ColumnReport,
  causes: ReadonlyMap<string, Cause>,
  numbers: ReadonlyMap<string, number>
): string {
  const { problems, notTried, passed } = groupColumn(col);
  if (!problems.length && !passed.length && !notTried.length) return '';
  const link = (cell: CellReport) =>
    `<a href="${esc(cell.resultsUrl)}"><code>${esc(cell.scenario)}</code></a>`;
  const reached = (cell: CellReport) => {
    const s = cell.summary;
    const counts =
      s && showsCounts(cell)
        ? `${s.passed} / ${s.failed} / ${s.warnings}`
        : '–';
    return (
      `<tr><td>${link(cell)}</td>` +
      `<td>${statePill(cell.state)}</td><td class=num>${counts}</td>` +
      `<td class=what>${happenedHtml(cell, causes, numbers)}</td></tr>`
    );
  };
  let rows = `<tr class=group><td colspan=4>${esc(col.revision)}</td></tr>`;
  rows += problems.map(reached).join('');
  if (notTried.length && !problems.length && !passed.length) {
    // Nothing reached at this revision: every startable cell is here, so
    // fold them rather than push the revisions the client did speak down.
    const items = notTried
      .map((cell) => `<li>${link(cell)}${notTriedHtml(cell)}</li>`)
      .join('');
    rows +=
      `<tr class=nottried><td colspan=4><details><summary>${esc(
        notTriedHeading(notTried.length, false)
      )}</summary><p class=muted>${esc(NOT_TRIED_WHY)}</p>` +
      `<ul class=nottried>${items}</ul></details></td></tr>`;
  } else if (notTried.length) {
    rows +=
      `<tr class=nottried><td colspan=4 class=head>${esc(
        notTriedHeading(notTried.length, true)
      )}<div class=muted>${esc(NOT_TRIED_WHY)}</div></td></tr>` +
      notTried
        .map(
          (cell) =>
            `<tr class=nottried><td>${link(cell)}</td><td>${statePill(cell.state)}</td>` +
            `<td class=num>–</td><td class=what>${notTriedHtml(cell)}</td></tr>`
        )
        .join('');
    if (passed.length) {
      rows += `<tr class=sub><td colspan=4>${esc(passedHeading(passed.length))}</td></tr>`;
    }
  }
  return rows + passed.map(reached).join('');
}

/** Every revision's cells in its groups, one table. */
function revisionsTable(report: RunReport): string {
  const causes = new Map(report.causes.map((c) => [c.key, c]));
  const numbers = causeNumbers(report.causes);
  const groups = report.columns
    .map((col) => revisionRows(col, causes, numbers))
    .join('');
  const reachedAny = report.columns.some((col) =>
    col.cells.some((c) => REACHED.includes(c.state))
  );
  const lead = reachedAny
    ? ''
    : '<p class=muted>No cell has been reached yet: point the client at a cell’s MCP URL.</p>';
  if (!groups) return lead;
  return (
    lead +
    `<table class=reached><tr><th>cell</th><th>result</th><th>pass / fail / warn</th><th>what happened</th></tr>` +
    `${groups}</table>`
  );
}

/**
 * The cells this deployment cannot start, once per scenario with its
 * revisions and the reason, folded at the bottom of the page.
 */
function unavailableSection(report: RunReport): string {
  const list = unavailableScenarios(report);
  if (!list.length) return '';
  const items = list
    .map(
      (u) =>
        `<li><code>${esc(u.scenario)}</code> <span class=muted>${u.revisions
          .map(esc)
          .join(', ')}</span> — ${esc(u.reason)}</li>`
    )
    .join('');
  return (
    `<details class=section id=unavailable><summary>${esc(
      UNAVAILABLE_HEADING
    )} (${list.length})</summary>` +
    `<p class=muted>${esc(UNAVAILABLE_WHY)}</p><ul>${items}</ul></details>`
  );
}

/** Each cause once, with the cells it covers. */
function causesList(report: RunReport): string {
  if (!report.causes.length) return '';
  const items = report.causes.map((c, i) => {
    const cells = c.cells
      .map(
        (key) =>
          `<a href="/results/${esc(report.runId)}/${esc(key)}">${esc(key)}</a>`
      )
      .join(', ');
    return (
      `<li id="cause-${i + 1}"><span class=pill style="${
        c.by === 'client' ? STATUS_STYLE.FAILURE : STATUS_STYLE.SKIPPED
      }">${BY_LABEL[c.by]}</span> ${c.check ? `<code>${esc(c.check)}</code> ` : ''}${esc(c.text)}` +
      `<div class=muted>${c.cells.length} cell${c.cells.length === 1 ? '' : 's'}: ${cells}</div></li>`
    );
  });
  return (
    `<h2>What went wrong, by cause</h2><p class=muted>Each cause once, with the cells it covers. ` +
    `<i>client</i>: seen in the client’s traffic. <i>not seen</i>: the scenario’s own ` +
    `expectation that nothing has met yet (the client may not have got that far).</p>` +
    `<ol class=causes>${items.join('')}</ol>`
  );
}

function scoringPillFor(cell: CellReport): string {
  return `<span class=pill style="${SCORING_STYLE[cell.scoring]}" title="${esc(
    cell.reason ?? ''
  )}">${SCORING_LABEL[cell.scoring]}</span>`;
}

export interface ReportPageOptions {
  /** The report as Markdown (see ./markdown.ts), for the copy button. */
  markdown: string;
  /** The same as plain lines (reportText()), for a chat without tables. */
  text: string;
  /** The live report, which a frozen copy links back to. */
  liveUrl: string;
  /** The run's frozen copies, listed on the live report. */
  snapshots?: readonly SnapshotInfo[];
}

/** The line under the heading: copy, other formats, freeze or "frozen". */
function reportActions(report: RunReport, opts: ReportPageOptions): string {
  const run = esc(report.runId);
  const here = report.snapshotId
    ? `/results/${run}/snapshot/${esc(report.snapshotId)}`
    : `/results/${run}${report.revision ? `/${esc(report.revision)}` : ''}`;
  const formats =
    `<button class=copy data-copy-text="${esc(opts.markdown)}">copy as Markdown</button> ` +
    `<button class=copy data-copy-text="${esc(opts.text)}" title="plain lines: Slack shows a Markdown table as raw pipes">copy for Slack</button> ` +
    `<a href="${here}?format=md">Markdown</a> · <a href="${here}?format=text">plain text</a> · <a href="${here}?format=json">JSON</a>`;
  if (report.frozenAt) {
    return (
      `<p class=note>A frozen copy, taken ${esc(utcMinute(report.frozenAt))}: it does not change ` +
      `as more traffic arrives, so it is safe to link from an issue or a chat. ` +
      `<a href="${esc(opts.liveUrl)}">The live report</a> has anything since; ` +
      `the cell links open the live results.</p><div class=actions>${formats}</div>`
    );
  }
  const earlier = opts.snapshots?.length
    ? `<p class=muted>Frozen copies of this run: ${opts.snapshots
        .map(
          (s) =>
            `<a href="/results/${run}/snapshot/${esc(s.id)}">${esc(
              utcMinute(new Date(s.createdAt).toISOString())
            )}</a>`
        )
        .join(' · ')}</p>`
    : '';
  return (
    `<div class=actions>${formats} · ` +
    `<form method=post action="/results/${run}/freeze" class=inline>` +
    `<button class=copy type=submit>freeze a copy to link to</button></form> ` +
    `<span class=muted>— a permalink to the whole run as it stands now; later traffic will not change it</span></div>` +
    earlier
  );
}

/** Report page for a run or one of its columns, live or frozen. */
export function renderReport(
  matrix: HostedMatrix,
  report: RunReport,
  opts: ReportPageOptions
): string {
  const title = report.frozenAt
    ? `results — run ${report.runId}, frozen ${utcMinute(report.frozenAt)}`
    : report.revision
      ? `results — run ${report.runId} @ ${report.revision}`
      : `results — run ${report.runId}`;
  const head =
    `<tr><th>scenario</th>` +
    report.columns
      .map(
        (col) =>
          `<th><a href="/results/${esc(report.runId)}/${esc(col.revision)}">${esc(
            col.revision
          )}</a><div class=muted>${esc(scoreText(col))}</div>` +
          `<div class=muted>${identityLine(col.identities)}</div></th>`
      )
      .join('') +
    '</tr>';
  // A scenario this deployment cannot start at any revision shown is listed
  // once at the bottom (unavailableSection()), not as a greyed-out row.
  const hidden = new Set<CellState>(['not-startable', 'n/a']);
  const rows = matrix.rows
    .map((row) =>
      report.columns.map(
        (col) => col.cells.find((c) => c.scenario === row.scenario)!
      )
    )
    .filter((cells) => cells.some((c) => !hidden.has(c.state)))
    .map(
      (cells) =>
        `<tr><td><code>${esc(cells[0].scenario)}</code></td>${cells
          .map(verdictCell)
          .join('')}</tr>`
    )
    .join('');
  const notScored = report.columns
    .map((col) => {
      if (!col.notScored.length) return '';
      const items = col.notScored
        .map(
          (c) =>
            `<li><code>${esc(c.scenario)}</code> ${statePill(
              c.state
            )} <span class=muted>${esc(
              SCORING_LABEL[c.scoring]
            )}${c.reason ? ` — ${esc(c.reason)}` : ''}</span> · <a href="${esc(
              c.resultsUrl
            )}">checks</a></li>`
        )
        .join('');
      return `<h3>${esc(col.revision)}: run but not scored</h3><ul>${items}</ul>`;
    })
    .join('');
  const run = esc(report.runId);
  const crumbs = [
    `<a href="/">matrix</a>`,
    `<a href="/results/${run}">run <code>${run}</code></a>`
  ];
  if (report.revision) crumbs.push(`<code>${esc(report.revision)}</code>`);
  if (report.frozenAt) {
    crumbs.push(`frozen ${esc(utcMinute(report.frozenAt))}`);
  }
  crumbs.push(
    `<a href="/s/${run}${
      report.revision ? `/${esc(report.revision)}` : ''
    }">config</a>`
  );
  const summary = report.columns
    .map((col) => {
      const counts = countsText(col.counts, [...REACHED, 'not-tried']);
      return (
        `<li><a href="/results/${run}/${esc(col.revision)}">${esc(col.revision)}</a>: ` +
        `${esc(scoreText(col))}` +
        `${counts ? ` <span class=muted>· reached: ${esc(counts)}</span>` : ''}</li>`
      );
    })
    .join('');
  return page(
    title,
    `<h1>results — run <code>${run}</code>${
      report.revision ? ` <small>@ ${esc(report.revision)}</small>` : ''
    }${report.frozenAt ? ' <small>(frozen)</small>' : ''}</h1>
<p class=crumbs>${crumbs.join(' › ')}</p>
${report.frozenAt ? '' : liveNote}<div id=live>
<p>Client: ${identityLine(report.identities)}</p>
${reportActions(report, opts)}
<h2>Summary</h2>
<ul>${summary}</ul>
${causesList(report)}
<h2>Cells by revision</h2>
<p class=muted>Each revision lists what needs a look first, then the cells your
client has not tried, then what passed. Cells this deployment cannot start are
listed once, folded, at the bottom of the page.</p>
${revisionsTable(report)}
<details><summary>as Markdown, to paste into an issue or a chat</summary><pre>${esc(
      opts.markdown
    )}</pre></details>
<h2>Every cell</h2>
<p class=muted>A cell passes when checks were recorded and none is a FAILURE.
A cell the client never reached reads <i>not tried</i>; one it reached where
nothing its scenario tests has happened yet reads <i>in progress</i> and lists
what it is waiting for; one whose only failures are steps it has not seen yet
(a sign-in or a form still to finish) reads <i>waiting</i>, though its verdict
is still a fail until they happen, or <i>stopped</i> once the client has sent nothing
for a few minutes with no sign-in or form open; one where the client stopped short (it spoke only
another revision, was turned away, and did not retry) reads <i>incomplete</i>.
The score leads with the scored cells you can run here (<i>X of the M scored
cells you can run here pass</i>) and keeps the requirement set's count
(<i>N are scored</i>); the other N−M cannot start on this deployment. Not-scored and unlisted cells are listed below the table;
scenarios this deployment cannot start are left out of it.</p>
<table>${head}${rows}</table>
${notScored}
${unavailableSection(report)}</div>
${report.frozenAt ? '' : liveScript}
${copyScript}`,
    report.server ?? null
  );
}
