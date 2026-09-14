/**
 * The run page (`/s/<run-id>`, and `/s/<run-id>/<rev>` for one revision),
 * written for the author of one client setting it up, and the bulk page
 * (`/s/<run-id>/bulk`) for testing many clients at once.
 *
 * The run page, top to bottom: what the run is and how many cells can start
 * at each revision; a "your client" picker (./config-picker.ts) whose block
 * covers the starter set only; then, with a live line on every URL, one URL
 * per revision for the scenarios that need no sign-in, the cells that need a
 * URL of their own, and the auth cells, `auth/metadata-default` first and
 * the rest folded by group; last, how many cells the client has reached and
 * how many need a look. The live lines refresh with the report's script
 * (./html.ts liveScript) and are judged as the report judges
 * (./run-status.ts).
 *
 * The bulk page has every client's block for every cell, the mcpServers map
 * of all of them, and the matrix of the run with each cell's steps.
 */

import {
  clientBlocks,
  copyScript,
  escapeHtml as esc,
  jsonForScript,
  liveNote,
  liveScript,
  page,
  renderMatrixTable,
  STATE_STYLE
} from './html';
import { configPicker, pickerScript } from './config-picker';
import {
  CLIENTS,
  clientConfig,
  compositeName,
  serverName,
  type ClientKind,
  type ServerEntry
} from './client-config';
import {
  COMPOSITE_SEPARATOR,
  DEFAULT_COMPOSITES,
  notComposableReason
} from './composite';
import { MCP_PATH, type HostedMatrix } from './matrix';
import type { CellConfig, RunConfig } from './server';
import type { CellState } from './report';
import type { ClientIdentity } from './identity';
import type { BuildInfo } from './build';
import type { CellLive, RunLive } from './run-status';

/** A ready-made composite of the run: its children and its URLs. */
interface ReadyComposite {
  revision: string;
  children: string[];
  /** The composite's page. */
  cell: string;
  /** Its MCP endpoint. */
  url: string;
}

/** The run's ready-made composites, per revision in scope. */
function readyComposites(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): ReadyComposite[] {
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

/** The auth cell a client should start with, at each revision. */
export const STARTER_AUTH = 'auth/metadata-default';

const isAuth = (c: Pick<CellConfig, 'scenario'>) =>
  c.scenario.startsWith('auth/');

/** The run's cells by where the run page lists them. */
function cellsOf(origin: string, matrix: HostedMatrix, config: RunConfig) {
  const composites = readyComposites(origin, matrix, config);
  const covered = new Set(
    composites.flatMap((c) =>
      c.children.map((child) => `${c.revision}/${child}`)
    )
  );
  return {
    composites,
    alone: config.cells.filter(
      (c) => !isAuth(c) && !covered.has(`${c.revision}/${c.scenario}`)
    ),
    auth: config.cells.filter(isAuth)
  };
}

/**
 * The entries of the client blocks. The full one (the bulk page) covers
 * every startable cell of the run once: the ready-made composites, then each
 * cell no composite carries (one that cannot share a URL, such as
 * `request-metadata`), then every auth cell, switched off where the client
 * can say so, since each starts a sign-in when the client connects (and
 * `codex mcp list` fetches the metadata of every one that is on). The
 * starter (the run page's picker): the composites and one auth cell per
 * revision, on.
 */
export function runClientEntries(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): { starter: ServerEntry[]; all: ServerEntry[] } {
  const { composites, alone, auth } = cellsOf(origin, matrix, config);
  const ready = composites.map((c) => ({
    name: compositeName(c.revision, c.children),
    url: c.url
  }));
  const entry = (c: CellConfig) => ({
    name: serverName(c.revision, c.scenario),
    url: c.url
  });
  return {
    starter: [
      ...ready,
      ...auth.filter((c) => c.scenario === STARTER_AUTH).map(entry)
    ],
    all: [
      ...ready,
      ...alone.map(entry),
      ...auth.map((c) => ({ ...entry(c), enabled: false }))
    ]
  };
}

/**
 * "At 2025-11-25, 18 cells can start here, and at 2026-07-28, 31 can.":
 * per revision, so a total is never read as a count at every revision.
 */
export function startableSentence(
  cells: readonly { revision: string }[],
  revisions: readonly string[]
): string {
  const parts = revisions.map((r, i) => {
    const n = cells.filter((c) => c.revision === r).length;
    return i === 0
      ? `At <code>${esc(r)}</code>, ${n} cell${n === 1 ? '' : 's'} can start here`
      : `at <code>${esc(r)}</code>, ${n} can`;
  });
  if (parts.length < 2) return `${parts.join('')}.`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

/**
 * Each state as the run page's live line says it: a glyph and a word on a
 * pill in the state's colour, so no state is told by colour alone. A cell
 * the client reached reads "reached" until it fails or stops; whether it
 * passes is the report's to say.
 */
export const LIVE_LABEL: Record<CellState, string> = {
  pass: '✓ reached',
  fail: '✗ fails',
  stopped: '■ stopped',
  waiting: '◔ waiting',
  'in-progress': '◑ in progress',
  incomplete: '◐ stopped short',
  'not-tried': '○ not reached yet',
  'not-startable': '⊘ unavailable',
  'n/a': '– not part of this revision'
};

function livePill(state: CellState): string {
  return `<span class=pill style="${STATE_STYLE[state]}">${esc(LIVE_LABEL[state])}</span>`;
}

/** "12 s ago", "3 min ago": how long before `now` the time `iso` was. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** Who the client said it was, short: "test-client 1.0.0". */
function who(identities: readonly ClientIdentity[]): string {
  const names = identities.map((i) => {
    if (i.name)
      return `<b>${esc(i.name)}</b>${i.version ? ` ${esc(i.version)}` : ''}`;
    if (i.userAgent) {
      const ua =
        i.userAgent.length > 40 ? `${i.userAgent.slice(0, 40)}…` : i.userAgent;
      return `<span title="${esc(i.userAgent)}">${esc(ua)}</span>`;
    }
    return 'an unnamed client';
  });
  return [...new Set(names)].join(', ');
}

/** "last request 12 s ago by test-client 1.0.0". */
function lastSeen(
  live: Pick<CellLive, 'lastRequestAt' | 'identities'>,
  now: number
): string {
  const parts: string[] = [];
  if (live.lastRequestAt) {
    parts.push(
      `last request <span title="${esc(live.lastRequestAt)}">${ago(live.lastRequestAt, now)}</span>`
    );
  }
  if (live.identities.length) parts.push(`by ${who(live.identities)}`);
  return parts.join(' ');
}

/** A cell nothing is known about yet reads not reached. */
const NOT_REACHED: CellLive = {
  state: 'not-tried',
  identities: [],
  resultsUrl: ''
};

/** One cell's live line: its state, then when and who, then its results. */
function cellLine(live: CellLive | undefined, now: number): string {
  const cell = live ?? NOT_REACHED;
  const seen = cell.state === 'not-tried' ? '' : lastSeen(cell, now);
  const results = cell.resultsUrl
    ? ` · <a href="${esc(cell.resultsUrl)}">results</a>`
    : '';
  return `${livePill(cell.state)}${seen ? ` ${seen}` : ''}${cell.state === 'not-tried' ? '' : results}`;
}

/** Worst first: what a composite's line leads with. */
const WORST: readonly CellState[] = [
  'fail',
  'stopped',
  'waiting',
  'incomplete',
  'in-progress',
  'pass'
];

/**
 * A composite's live line, over its children: the worst state any reached
 * child is in, how many were reached, and the latest request among them.
 */
function compositeLine(children: CellLive[], now: number): string {
  const reached = children.filter((c) => c.state !== 'not-tried');
  if (!reached.length) return livePill('not-tried');
  const state = WORST.find((s) => reached.some((c) => c.state === s)) ?? 'pass';
  const latest = reached
    .map((c) => c.lastRequestAt)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const identities = new Map<string, ClientIdentity>();
  for (const c of reached) {
    for (const i of c.identities) {
      identities.set(`${i.name}\n${i.version}\n${i.userAgent}`, i);
    }
  }
  const failing = reached.filter((c) => c.state === 'fail').length;
  const counts =
    `${reached.length} of ${children.length} scenarios reached` +
    (failing ? `, ${failing} fail${failing === 1 ? 's' : ''}` : '');
  const seen = lastSeen(
    {
      ...(latest && { lastRequestAt: latest }),
      identities: [...identities.values()]
    },
    now
  );
  return `${livePill(state)} ${counts}${seen ? `, ${seen}` : ''}`;
}

/** One URL row: revision, what it is, copy, and the live line under it. */
function urlRow(
  revision: string,
  what: string,
  url: string,
  line: string,
  more = ''
): string {
  return (
    `<div class=u><b>${esc(revision)}</b><span class=url>${what}</span>` +
    `<button class=copy data-copy-text="${esc(url)}" title="${esc(url)}">copy URL</button>` +
    `<div class=stat>${line}${more}</div></div>`
  );
}

/** A single cell's row: its name linked to its page. */
function cellRow(
  runId: string,
  c: CellConfig,
  live: RunLive,
  note = ''
): string {
  const key = `${c.revision}/${c.scenario}`;
  return urlRow(
    c.revision,
    `<a href="/s/${esc(runId)}/${esc(key)}"><code>${esc(c.scenario)}</code></a>${
      note ? ` <span class=muted>${esc(note)}</span>` : ''
    }`,
    c.url,
    cellLine(live.cells.get(key), live.now)
  );
}

function compositeRows(composites: ReadyComposite[], live: RunLive): string {
  return composites
    .map((c) => {
      const children = c.children.map(
        (child) => live.cells.get(`${c.revision}/${child}`) ?? NOT_REACHED
      );
      const each = c.children
        .map(
          (child, i) =>
            `<li><code>${esc(child)}</code> ${cellLine(children[i], live.now)}</li>`
        )
        .join('');
      const fold =
        `<details id="behind-${esc(c.revision)}"><summary>the ${c.children.length} scenarios behind it</summary>` +
        `<ul class=behind>${each}</ul></details>`;
      return urlRow(
        c.revision,
        `<code>${esc(c.url)}</code> <a href="${esc(c.cell)}">${c.children.length} scenarios</a>`,
        c.url,
        compositeLine(children, live.now),
        fold
      );
    })
    .join('');
}

/** Auth cells by what they test, as the rest of the auth list is folded. */
const AUTH_GROUPS: readonly [id: string, title: string, test: RegExp][] = [
  ['metadata', 'Metadata discovery', /^auth\/metadata-(default|var\d+)$/],
  ['scopes', 'Scopes', /^auth\/(scope-|offline-access-)/],
  [
    'client-auth',
    'Registration and token endpoint authentication',
    /^auth\/(token-endpoint-auth-|pre-registration$|basic-cimd$)/
  ],
  ['issuer', 'Issuer checks', /^auth\/(iss-|metadata-issuer-mismatch$)/],
  ['other', 'Other auth', /^auth\//]
];

/** What the cells of a fold stand at, for its summary: "2 reached, 1 fails". */
function foldCounts(cells: CellConfig[], live: RunLive): string {
  const states = cells.map(
    (c) => live.cells.get(`${c.revision}/${c.scenario}`)?.state ?? 'not-tried'
  );
  const reached = states.filter((s) => s !== 'not-tried').length;
  if (!reached) return '';
  const failing = states.filter((s) => s === 'fail').length;
  return ` · ${reached} reached${failing ? `, ${failing} fail${failing === 1 ? 's' : ''}` : ''}`;
}

function authSection(
  auth: CellConfig[],
  matrix: HostedMatrix,
  config: RunConfig,
  live: RunLive
): string {
  if (!auth.length) {
    const revision = config.revision ?? matrix.revisions[0];
    const reason = matrix.cell(STARTER_AUTH, revision)?.startReason;
    return `<p class=muted>This deployment cannot start the auth cells${
      reason ? `: ${esc(reason)}` : ''
    }.</p>`;
  }
  const order = new Map(matrix.rows.map((r, i) => [r.scenario, i]));
  const byScenario = (a: CellConfig, b: CellConfig) =>
    (order.get(a.scenario) ?? 0) - (order.get(b.scenario) ?? 0) ||
    a.revision.localeCompare(b.revision);
  const starters = auth.filter((c) => c.scenario === STARTER_AUTH);
  const rest = auth.filter((c) => c.scenario !== STARTER_AUTH);
  const placed = new Set<CellConfig>();
  const folds = AUTH_GROUPS.map(([id, title, test]) => {
    const cells = rest
      .filter((c) => !placed.has(c) && test.test(c.scenario))
      .sort(byScenario);
    cells.forEach((c) => placed.add(c));
    if (!cells.length) return '';
    return (
      `<details id="auth-${id}"><summary>${esc(title)} (${cells.length})${foldCounts(cells, live)}</summary>` +
      cells.map((c) => cellRow(config.runId, c, live)).join('') +
      '</details>'
    );
  }).join('');
  return (
    `<p class=muted>Start with <code>${STARTER_AUTH}</code> at each revision. The test ` +
    `authorization server approves the sign-in at once, with no account.</p>` +
    starters
      .sort(byScenario)
      .map((c) => cellRow(config.runId, c, live))
      .join('') +
    folds
  );
}

/** Why a cell outside the composites needs a URL of its own. */
function aloneNote(scenario: string): string {
  return notComposableReason(scenario) ?? 'not in the ready-made composite';
}

/** The last step: how far the client has got, and the way to the results. */
function resultsLine(config: RunConfig, live: RunLive): string {
  const cells = (n: number) => `${n} cell${n === 1 ? '' : 's'}`;
  const said = !live.reached
    ? 'Your client has not reached any cell yet.'
    : `Your client has reached ${cells(live.reached)} so far, and ${
        live.needsLook
          ? `${live.needsLook} need${live.needsLook === 1 ? 's' : ''} a look`
          : 'none needs a look'
      }.`;
  return (
    `<div class=summary>${said} ` +
    `<a class=btn href="${esc(config.resultsUrl)}">Open the results</a></div>`
  );
}

const runCss = `<style>
  ol.setup{list-style:none;padding:0;margin:1rem 0;counter-reset:s}
  ol.setup>li{counter-increment:s;border:1px solid #e5e7eb;border-radius:8px;
    padding:.6rem .75rem .6rem 2.75rem;margin:.6rem 0;position:relative}
  ol.setup>li::before{content:counter(s);position:absolute;left:.75rem;top:.65rem;
    width:1.4rem;height:1.4rem;border-radius:50%;background:#111;color:#fff;
    text-align:center;font-weight:700;font-size:12px;line-height:1.4rem}
  ol.setup h2{font-size:15px;margin:0 0 .3rem}
  .u{display:grid;grid-template-columns:minmax(6rem,max-content) 1fr auto;
    gap:.2rem .6rem;align-items:center;padding:.4rem 0;border-top:1px solid #eee}
  .u .url{overflow-wrap:anywhere}
  .u .stat{grid-column:2/4;font-size:12px}
  ul.behind,ul.urls{margin:.3rem 0;padding-left:1.25rem}
  .picker select{font:inherit;padding:1px 6px}
  .picker [data-pick]{margin-top:.4rem}
  .summary{border:1px solid #e5e7eb;background:#f8fafc;border-radius:8px;
    padding:.5rem .75rem}
  a.btn{display:inline-block;padding:2px 10px;border:1px solid #111;
    border-radius:6px;font-weight:600;text-decoration:none;color:#111}
  @media (max-width:560px){.u{grid-template-columns:1fr auto}
    .u .url{grid-column:1/3}.u .stat{grid-column:1/3}}
</style>`;

function runCrumbs(config: RunConfig, here?: string): string {
  const run = esc(config.runId);
  const parts = [
    `<a href="/">matrix</a>`,
    `<a href="/s/${run}">run <code>${run}</code></a>`
  ];
  if (config.revision) parts.push(`<code>${esc(config.revision)}</code>`);
  if (here) parts.push(here);
  return `<p class=crumbs>${parts.join(' › ')} · <a href="${esc(config.resultsUrl)}">results</a></p>`;
}

/** The run page, or one revision's (`config.revision`). */
export function renderRunPage(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig,
  live: RunLive,
  build?: BuildInfo
): string {
  const run = esc(config.runId);
  const revisions = config.revision ? [config.revision] : matrix.revisions;
  const { composites, alone, auth } = cellsOf(origin, matrix, config);
  const { starter, all } = runClientEntries(origin, matrix, config);
  const bulk = `/s/${run}/bulk`;
  const picker = configPicker(starter, {
    urlPanel:
      '<p class=muted>Each URL below has a copy button: paste it wherever your client adds a server.</p>'
  });
  const noSignIn = composites.length
    ? compositeRows(composites, live)
    : '<p class=muted>No revision here has scenarios that can share a URL.</p>';
  const own = alone.length
    ? `<li><h2 id=own-url>Add the cells that need a URL of their own</h2>` +
      alone
        .map((c) => cellRow(config.runId, c, live, aloneNote(c.scenario)))
        .join('') +
      '</li>'
    : '';
  const title = config.revision
    ? `run ${config.runId} @ ${config.revision}`
    : `run ${config.runId}`;
  return page(
    title,
    `${runCss}<h1>Set up run <code>${run}</code>${
      config.revision ? ` <small>@ ${esc(config.revision)}</small>` : ''
    }</h1>
${runCrumbs(config)}
<p>A run tests one client. Point your client at the URLs below: each cell records
what your client sends to its URL, and the <a href="${esc(config.resultsUrl)}">results</a>
judge it. Use a <a href="/s">new run</a> for another client.
${startableSentence(config.cells, revisions)}</p>
<ol class=setup>
<li><h2 id=client-config>Pick your client</h2>${picker}
<p class=muted>The block covers the starter set: the one URL per revision below and
<code>${STARTER_AUTH}</code> at each revision. Testing many clients at once? Every
client’s block for all ${all.length} entries, and one <code>mcpServers</code> block for all
${config.cells.length} cells, are on the <a href="${bulk}">bulk page</a>.</p></li>
</ol>
${liveNote}<div id=live>
<ol class=setup style="counter-reset:s 1">
<li><h2 id=composites>Add one URL per revision for the scenarios that need no sign-in</h2>
<p class=muted>Each scenario behind the URL still records and scores in its own cell.</p>
${noSignIn}</li>
${own}
<li><h2 id=auth>Add the auth cells, one URL and one sign-in each</h2>
${authSection(auth, matrix, config, live)}</li>
<li><h2 id=results>Read the results</h2>
${resultsLine(config, live)}</li>
</ol></div>
${liveScript}
${copyScript}
${pickerScript}`,
    build
  );
}

/**
 * The bulk page: every client's block for every startable cell of the run
 * (runClientEntries().all), one mcpServers map of all of them, and the
 * matrix of the run with each cell's steps and links.
 */
export function renderBulkPage(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig,
  build?: BuildInfo
): string {
  const run = esc(config.runId);
  const { all } = runClientEntries(origin, matrix, config);
  const embedded = `<script type="application/json" id="cfg">${jsonForScript(config)}</script>`;
  return page(
    `run ${config.runId}: every client's config`,
    `<h1>Every client’s config for run <code>${run}</code></h1>
${runCrumbs(config, 'bulk')}
<p>For testing several clients at once. For one client, the
<a href="/s/${run}">run page</a> gives the URLs to start with and shows which ones
your client has reached.
<button class=copy data-copy="all">copy mcpServers for all ${config.cells.length}</button>
<span class=muted>— one entry per cell, keyed <code>&lt;revision&gt;/&lt;scenario&gt;</code></span></p>
${clientBlocks(
  all,
  `Each block covers every startable cell of the run once: the ready-made composites, each cell that cannot share a URL ` +
    '(such as <code>request-metadata</code>), and every auth cell, switched off where the client can say so: ' +
    'switch on the ones you want to test.',
  `copy all ${all.length}`
)}
<h2 id=cells>Every cell</h2>
<p class=muted>Each startable cell with its own URL, its steps, and the <code>mcpServers</code>
entry plus the env the CLI runner would set.</p>
${renderMatrixTable(matrix, { origin, runId: config.runId })}
${embedded}
${copyScript}`,
    build
  );
}

/** The bulk page as JSON: the run's config, and every client's full block. */
export function bulkJson(
  origin: string,
  matrix: HostedMatrix,
  config: RunConfig
): RunConfig & { clients: Record<ClientKind, string> } {
  const { all } = runClientEntries(origin, matrix, config);
  const clients = Object.fromEntries(
    CLIENTS.map((c) => [c.kind, clientConfig(c.kind, all)])
  ) as Record<ClientKind, string>;
  return { ...config, clients };
}
