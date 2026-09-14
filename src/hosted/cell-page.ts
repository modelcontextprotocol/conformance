/**
 * The page about one cell, at its results path and its config path alike:
 * for the author of one client, debugging one failing test and running it
 * again, and for a server author reading that client's traffic.
 *
 *   1. the verdict, in a shape, a glyph and a word, and the attempt it is
 *      from, with "Reset this cell" and the earlier attempts folded;
 *   2. for a failing or stopped cell, what to fix: the failing check in
 *      words, the spec sentence, and the exchange that caused it, with the
 *      offending field marked and expected against actual where the check
 *      says both;
 *   3. the scenario's steps as a checklist, each tied to its exchanges;
 *   4. the traffic, one numbered list, with a gutter of three lanes (the
 *      cell's MCP endpoint, metadata at its origin, its sign-in server);
 *   5. the passed checks, folded.
 *
 * The set-up (the MCP URL, the steps, the credentials and the env) is
 * folded below; client config files are the run page's. A frozen copy of
 * the cell renders the same data without the live parts.
 */

import type { CheckStatus, ConformanceCheck } from '../types';
import { describeStep, type Step } from '../steps';
import type { CellConfig, CellStatus } from './server';
import type { CellRef } from './session';
import type { CellState, Verdict } from './report';
import type { ClientIdentity } from './identity';
import type { ShownCheck } from './shown';
import { STATE_LABEL, countsLine, utcMinute } from './markdown';
import { summarize } from './report';
import { isStatefulVersion } from '../connection/versions';
import {
  connectionNumbers,
  exchangeFor,
  REFUSED_TEXT,
  type Exchange,
  type Lane
} from './traffic';
import {
  STATUS_STYLE,
  about,
  authSteps,
  copyScript,
  credentials,
  envPre,
  escapeHtml as esc,
  handNote,
  identityLine,
  liveNote,
  liveScript,
  page,
  prose,
  statePill,
  stepsOpen
} from './html';
import type { BuildInfo } from './build';
import { configPicker, pickerScript } from './config-picker';
import { serverName } from './client-config';

/** A glyph per state, so none is told by colour alone. */
export const STATE_GLYPH: Record<CellState, string> = {
  pass: '✓',
  fail: '✗',
  waiting: '◔',
  stopped: '■',
  'in-progress': '◑',
  incomplete: '◒',
  'not-tried': '○',
  'not-startable': '⊘',
  'n/a': '–'
};

const CHECK_GLYPH: Record<CheckStatus, string> = {
  SUCCESS: '✓',
  FAILURE: '✗',
  WARNING: '!',
  SKIPPED: '–',
  INFO: 'i'
};

/** An attempt before the current one, as its line on the page says it. */
export interface EarlierSummary {
  attempt: number;
  /** When a reset started it; absent for the first. */
  startedAt?: string;
  /** Its first and last request. */
  firstRequestAt?: string;
  lastRequestAt?: string;
  verdict: Verdict;
  state: CellState;
  /** What decided it, in one line: its first failure, or its note. */
  cause?: string;
}

/** What a cell's page shows; what a frozen copy of the cell stores. */
export interface CellPageData {
  ref: CellRef;
  /** The scenario's description. */
  description: string;
  status: CellStatus;
  shown: ShownCheck[];
  identities: ClientIdentity[];
  /** The current attempt (1 until the cell is reset). */
  attempt: number;
  /** When a reset started the current attempt. */
  resetAt?: string;
  earlier: EarlierSummary[];
  /** The current attempt's traffic, in time order. */
  traffic: { exchanges: Exchange[]; omitted: number };
  /** The MCP URL the client is given. */
  mcpUrl?: string;
  steps?: readonly Step[];
}

/** What only the live page has. */
export interface CellPageLive {
  /** The cell's config: the set-up section. */
  config?: CellConfig;
  /** Whether "Reset this cell" is offered. */
  resettable: boolean;
}

/** What only a frozen copy has. */
export interface CellPageFrozen {
  snapshotId: string;
  frozenAt: string;
}

/** Log rows the traffic list replaces: the scenarios' own request logs. */
export const LOG_ROW = /^(incoming|outgoing)-(auth-)?(request|response)$/;

/** Hosted-layer bookkeeping never listed as a check (identity has its line). */
const UNLISTED = new Set(['hosted-client-identity']);

const LANE_TITLE: Record<Lane, string> = {
  mcp: 'the cell’s MCP endpoint',
  metadata: 'metadata at the cell’s origin',
  'sign-in': 'the sign-in server'
};

const LANES: readonly Lane[] = ['mcp', 'metadata', 'sign-in'];

const cellCss = `
  .glyph{font-weight:700}
  .verdict{border-left:5px solid #d1d5db;padding:.5rem .75rem;margin:.75rem 0;
    border-radius:6px;background:#f9fafb}
  .verdict.fail{border-left-color:#dc2626}.verdict.pass{border-left-color:#16a34a}
  .verdict.waiting,.verdict.stopped,.verdict.incomplete,.verdict.in-progress{border-left-color:#d97706}
  .verdict .big{font-size:16px;font-weight:600}
  .attempts{border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .75rem;margin:.5rem 0;background:#f9fafb}
  .fix{border:1px solid #fca5a5;border-radius:8px;padding:.5rem .75rem;margin:.75rem 0}
  .fix h2{margin:.2rem 0 .4rem}
  blockquote{margin:.4rem 0;padding:.2rem .75rem;border-left:3px solid #d1d5db}
  pre mark{background:#fee2e2;color:#991b1b;font-weight:700}
  ul.checklist{list-style:none;padding-left:0}
  ul.checklist li{margin:.25rem 0}
  table.traffic td,table.traffic th{font-size:12px;padding:.25rem .4rem}
  table.traffic td.lane{width:10px;padding:.25rem 1px;text-align:center;color:#6b7280}
  table.traffic td.lane.on{color:#111}
  table.traffic tr.bad td{background:#fef2f2}
  table.traffic tr.note td{color:#6b7280;font-style:italic;background:#fff}
  table.traffic td.t{white-space:nowrap;font-variant-numeric:tabular-nums}
  table.traffic tr:target td{background:#fef9c3}
  table.xa{width:auto}
  ul.urls{margin:.3rem 0;padding-left:1.25rem}
  .picker select{font:inherit;padding:1px 6px}
  .picker [data-pick]{margin-top:.4rem}
`;

function time(iso: string): string {
  return `${iso.slice(11, 23)}`;
}

/** "2 minutes 10 seconds". */
function gapText(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const parts: string[] = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s % 60) parts.push(`${s % 60} second${s % 60 === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 seconds';
}

/** A pause this long between two exchanges is said in words. */
const GAP_MS = 30_000;

function statusText(status: number | undefined): string {
  return status === undefined ? 'stream open' : String(status);
}

function rpcText(e: Exchange): string {
  const rpc = e.rpc ?? [];
  if (!rpc.length) return '';
  return rpc
    .map((m) =>
      m.method
        ? `${m.method}${m.id !== undefined ? ` (id ${JSON.stringify(m.id)})` : ''}`
        : `response${m.id !== undefined ? ` to id ${JSON.stringify(m.id)}` : ''}`
    )
    .join(', ');
}

function pretty(text: string | undefined): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * An exchange as text: the request line, its headers and body, then the
 * answer. Lines naming one of `fields` are marked; a field the request
 * should have carried and did not is added, marked, as "missing".
 */
function exchangeText(
  e: Exchange,
  fields: readonly string[] = [],
  missing: readonly string[] = []
): string {
  const lines: string[] = [`${e.method} ${e.path}`];
  for (const [k, v] of Object.entries(e.headers)) lines.push(`${k}: ${v}`);
  lines.push(
    `authorization: ${e.authorization}${
      e.refused === 'token' ? ' (issued before the reset; withheld)' : ''
    }`
  );
  if (e.body !== undefined) {
    lines.push('', ...pretty(e.body).split('\n'));
    if (e.bodyBytes) lines.push(`… cut at 8 KB of ${e.bodyBytes} bytes`);
  }
  for (const f of missing) lines.push(`${f}: missing`);
  const answer: string[] = ['', `← ${statusText(e.status)}`];
  for (const [k, v] of Object.entries(e.responseHeaders ?? {}))
    answer.push(`${k}: ${v}`);
  if (e.responseBody !== undefined) {
    answer.push('', ...pretty(e.responseBody).split('\n'));
    if (e.responseBytes)
      answer.push(`… cut at 8 KB of ${e.responseBytes} bytes`);
  }
  const marked = (line: string, i: number) => {
    const hit =
      i < lines.length &&
      (missing.some((f) => line === `${f}: missing`) ||
        fields.some((f) => {
          const lower = line.toLowerCase();
          const name = f.toLowerCase();
          return (
            lower.includes(`"${name}"`) ||
            lower.startsWith(`${name}:`) ||
            lower.includes(`${name}=`)
          );
        }));
    return hit ? `<mark>${esc(line)}</mark>` : esc(line);
  };
  return `<pre>${[...lines, ...answer].map(marked).join('\n')}</pre>`;
}

/** Details keys that say nothing about which field was at fault. */
const GENERIC_KEYS = new Set([
  'message',
  'method',
  'path',
  'reason',
  'errorMessage',
  'untestable',
  'token',
  'scopes',
  'mcpMethod',
  'statusCode',
  'headers',
  'body'
]);

const MISSING_VALUES = new Set(['(omitted)', '(missing)', 'missing', 'absent']);

/** The fields a check's details point at, and which of them were missing. */
function faultFields(c: ConformanceCheck): {
  fields: string[];
  missing: string[];
} {
  const fields: string[] = [];
  const missing: string[] = [];
  for (const [k, v] of Object.entries(c.details ?? {})) {
    if (GENERIC_KEYS.has(k) || /^expected/i.test(k)) continue;
    if (typeof v === 'object' && v !== null) continue;
    if (/protocol.?version/i.test(k)) fields.push('mcp-protocol-version');
    else fields.push(k);
    if (typeof v === 'string' && MISSING_VALUES.has(v)) missing.push(k);
  }
  return { fields, missing };
}

/** Expected against actual, when the check's details say both. */
function expectedActual(
  c: ConformanceCheck
): Array<[string, unknown, unknown]> {
  const d = c.details ?? {};
  const out: Array<[string, unknown, unknown]> = [];
  for (const [k, v] of Object.entries(d)) {
    const m = /^expected(.*)$/i.exec(k);
    if (!m) continue;
    const rest = m[1];
    const lower = rest ? rest[0].toLowerCase() + rest.slice(1) : '';
    const candidates = rest
      ? [
          `actual${rest}`,
          `received${rest}`,
          `got${rest}`,
          lower,
          `${lower}Sent`
        ]
      : ['actual', 'received', 'got'];
    const found = candidates.find((x) => x in d && x !== k);
    if (found) out.push([rest ? lower : 'value', v, d[found]]);
  }
  return out;
}

/** The spec references of a check that are about the cell's revision. */
function referencesFor(c: ConformanceCheck, revision: string) {
  const refs = c.specReferences ?? [];
  const at = refs.filter((r) => r.url?.includes(`/specification/${revision}/`));
  if (at.length) return at;
  return refs.filter(
    (r) => !/\/specification\/\d{4}-\d{2}-\d{2}\//.test(r.url ?? '')
  );
}

function refsHtml(c: ConformanceCheck, revision: string): string {
  return referencesFor(c, revision)
    .map((r) =>
      r.url
        ? `<a href="${esc(r.url)}">${esc(r.id)}</a>`
        : `<span>${esc(r.id)}</span>`
    )
    .join(' · ');
}

/** The check's requirement as the spec words it, when its description does. */
function specSentence(c: ConformanceCheck): string | undefined {
  const d = c.description ?? '';
  return /\b(MUST|SHOULD|SHALL|REQUIRED|MAY)\b/.test(d) ? d : undefined;
}

function exchangeLink(i: number | undefined, exchanges: readonly Exchange[]) {
  if (i === undefined) return '';
  const e = exchanges[i];
  return ` <a href="#x${i + 1}" class=muted title="${esc(`${e.method} ${e.path}`)}">exchange ${i + 1}</a>`;
}

function verdictLine(data: CellPageData): string {
  const { status, shown } = data;
  const state = status.state;
  const glyph = STATE_GLYPH[state];
  const counted = shown.filter(
    (c) => c.status === 'SUCCESS' || (c.status === 'FAILURE' && !c.notSeen)
  );
  const failed = counted.filter((c) => c.status === 'FAILURE').length;
  const warnings = shown.filter((c) => c.status === 'WARNING').length;
  let text: string;
  if (state === 'pass') {
    text = `all ${counted.length} check${counted.length === 1 ? '' : 's'} passed${
      warnings ? `, with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''
    }`;
  } else if (state === 'fail') {
    text = `${failed} of ${counted.length} checks failed`;
  } else if (status.verdict === 'n/a') {
    text = `the scenario does not apply to this revision: ${status.reason ?? ''}`;
  } else if (status.startable === false) {
    text = `not startable here: ${status.startReason ?? ''}`;
  } else {
    // The label says the state; the note need not say it again.
    text = (status.note ?? '').replace(/^stopped: /, '');
  }
  // Skipped checks are said apart: nothing was checked, so they are
  // neither a pass nor a failure.
  const counts = summarize(shown);
  const countsHtml = shown.length
    ? `<p>${esc(countsLine(counts))}${
        counts.skipped
          ? ` <span class=muted>· ${counts.skipped} skipped: the client did nothing they check</span>`
          : ''
      }</p>`
    : '';
  return (
    `<div class="verdict ${esc(state)}"><span class=big><span class=glyph aria-hidden=true>${glyph}</span> ` +
    `${esc(STATE_LABEL[state])}</span>${text ? `: ${esc(text)}` : ''}` +
    countsHtml +
    `<div class=muted>Client: ${identityLine(data.identities)}</div></div>`
  );
}

/** "Attempt 2 · started 06:50:12 by a reset", the reset button, and earlier ones. */
function attemptsBlock(
  data: CellPageData,
  resetUrl: string | undefined
): string {
  const started = data.resetAt
    ? ` · started ${esc(time(data.resetAt))} UTC by a reset`
    : '';
  const head = `<b>Attempt ${data.attempt}</b>${started}`;
  const button = resetUrl
    ? ` <form method=post action="${esc(resetUrl)}" class=inline><button class=copy type=submit>Reset this cell</button></form>` +
      `<div class=muted>Keeps the MCP URL. Your client’s next request starts attempt ${data.attempt + 1}; ` +
      `what this attempt recorded stays, listed under it. On a sign-in cell it also forgets the ` +
      `registrations, codes and tokens this cell issued, so your client has to sign in again.</div>`
    : '';
  const earlier = data.earlier.length
    ? `<details id=earlier><summary>${data.earlier.length} earlier attempt${
        data.earlier.length === 1 ? '' : 's'
      }</summary><ul>${data.earlier
        .slice()
        .reverse()
        .map((a) => {
          const when = a.startedAt ?? a.firstRequestAt;
          return (
            `<li>Attempt ${a.attempt}${when ? ` · ${esc(time(when))} UTC` : ''} · ` +
            `<span class=glyph aria-hidden=true>${STATE_GLYPH[a.state]}</span> ${esc(
              STATE_LABEL[a.state]
            )}${a.cause ? ` — ${esc(a.cause)}` : ''}</li>`
          );
        })
        .join('')}</ul></details>`
    : '';
  if (data.attempt === 1 && !button && !earlier) return '';
  return `<div class=attempts>${head}${button}${earlier}</div>`;
}

/** Each check's exchange, by index into the traffic. */
function linker(exchanges: readonly Exchange[]) {
  const cache = new Map<ConformanceCheck, number | undefined>();
  return (c: ConformanceCheck) => {
    if (!cache.has(c)) cache.set(c, exchangeFor(c.timestamp, exchanges));
    return cache.get(c);
  };
}

function fixBlock(
  data: CellPageData,
  at: (c: ConformanceCheck) => number | undefined
): string {
  const { exchanges } = data.traffic;
  const revision = data.ref.revision;
  if (data.status.state === 'stopped') {
    const last = exchanges.length - 1;
    const waiting = data.shown.filter((c) => c.notSeen);
    return (
      `<div class=fix><h2>What to fix</h2><p>Your client stopped${
        last >= 0
          ? ` after exchange <a href="#x${last + 1}">${last + 1}</a> (${esc(
              `${exchanges[last].method} ${exchanges[last].path}`
            )} at ${esc(time(exchanges[last].at))} UTC)`
          : ''
      } and has sent nothing since. The flow was still waiting for:</p><ul>${waiting
        .map((c) => `<li><code>${esc(c.id)}</code> ${esc(c.reason ?? '')}</li>`)
        .join('')}</ul>` +
      (last >= 0 ? exchangeText(exchanges[last]) : '') +
      `<p class=muted>Check your client’s log for an error after that request, then run it again` +
      ` (Reset this cell first to start clean).</p></div>`
    );
  }
  if (data.status.state !== 'fail') return '';
  const failures = data.shown.filter(
    (c) => c.status === 'FAILURE' && !c.notSeen
  );
  const shownHere = failures.slice(0, 3);
  const items = shownHere.map((c) => {
    const i = at(c);
    const sentence = specSentence(c);
    const refs = refsHtml(c, revision);
    const { fields, missing } = faultFields(c);
    const pairs = expectedActual(c);
    const e = i === undefined ? undefined : exchanges[i];
    return (
      `<p><span class=glyph aria-hidden=true>✗</span> <b>${esc(c.reason ?? c.name)}</b> ` +
      `<span class=muted><code>${esc(c.id)}</code></span></p>` +
      (sentence
        ? `<blockquote>${esc(sentence)}</blockquote>${refs ? `<p class=muted>${refs}</p>` : ''}`
        : refs
          ? `<p class=muted>${refs}</p>`
          : '') +
      (pairs.length
        ? `<table class=xa><tr><th></th><th>expected</th><th>your client sent</th></tr>${pairs
            .map(
              ([k, want, got]) =>
                `<tr><th>${esc(k)}</th><td><code>${esc(JSON.stringify(want))}</code></td><td><code>${esc(
                  JSON.stringify(got) ?? 'nothing'
                )}</code></td></tr>`
            )
            .join('')}</table>`
        : '') +
      (e
        ? `<p>It was decided by exchange <a href="#x${i! + 1}">${i! + 1}</a> (${esc(
            `${e.method} ${e.path}`
          )} at ${esc(time(e.at))} UTC):</p>${exchangeText(e, fields, missing)}`
        : `<p class=muted>No recorded exchange carries it${
            data.traffic.omitted ? ' (some traffic was not kept)' : ''
          }.</p>`)
    );
  });
  const more =
    failures.length > shownHere.length
      ? `<p class=muted>and ${failures.length - shownHere.length} more failing check${
          failures.length - shownHere.length === 1 ? '' : 's'
        } below.</p>`
      : '';
  return `<div class=fix><h2>What to fix</h2>${items.join('<hr>')}${more}</div>`;
}

interface StepLine {
  text: string;
  exchanges: number[];
}

/** The generic sign-in, as steps a client takes, each with its exchanges. */
function authStepLines(
  scenario: string,
  exchanges: readonly Exchange[]
): StepLine[] {
  const where = (pred: (e: Exchange) => boolean) =>
    exchanges.flatMap((e, i) => (pred(e) ? [i] : []));
  const route = (e: Exchange) => e.path.split('?')[0];
  const noSignIn = /^auth\/(client-credentials-|wif-|enterprise-managed-)/.test(
    scenario
  );
  const lines: StepLine[] = [
    {
      text: 'ask for the MCP endpoint without a token; the cell answers 401',
      exchanges: where(
        (e) =>
          e.lane === 'mcp' && e.authorization === 'absent' && e.status === 401
      )
    },
    {
      text: 'find the protected-resource metadata',
      exchanges: where((e) =>
        route(e).startsWith('/.well-known/oauth-protected-resource')
      )
    },
    {
      text: 'find the sign-in server’s metadata',
      exchanges: where(
        (e) => e.lane === 'sign-in' && route(e).includes('/.well-known/')
      )
    }
  ];
  if (!noSignIn) {
    lines.push(
      {
        text: 'register the client, unless it has an id already',
        exchanges: where(
          (e) => e.lane === 'sign-in' && route(e).endsWith('/register')
        )
      },
      {
        text: 'send the person to sign in (the test server approves at once)',
        exchanges: where(
          (e) => e.lane === 'sign-in' && route(e).endsWith('/authorize')
        )
      }
    );
  }
  lines.push(
    {
      text: noSignIn
        ? 'get a token with the credentials the cell gives'
        : 'exchange the code for a token',
      exchanges: where(
        (e) => e.lane === 'sign-in' && route(e).endsWith('/token')
      )
    },
    {
      text: 'call the MCP endpoint with the token',
      exchanges: where(
        (e) =>
          e.lane === 'mcp' &&
          e.authorization === 'present' &&
          !e.refused &&
          (e.status ?? 0) < 400
      )
    }
  );
  return lines;
}

function methodsOf(e: Exchange): string[] {
  return (e.rpc ?? []).flatMap((m) => (m.method ? [m.method] : []));
}

function stepLines(
  data: CellPageData,
  exchanges: readonly Exchange[]
): StepLine[] {
  if (data.ref.scenarioName.startsWith('auth/'))
    return authStepLines(data.ref.scenarioName, exchanges);
  const where = (pred: (e: Exchange) => boolean) =>
    exchanges.flatMap((e, i) => (pred(e) ? [i] : []));
  // The stateless wire has no handshake: a client may start with any call.
  const lines: StepLine[] = isStatefulVersion(data.ref.revision)
    ? [
        {
          text: 'connect (initialize)',
          exchanges: where((e) => methodsOf(e).includes('initialize'))
        }
      ]
    : [];
  for (const step of data.steps ?? []) {
    if (step.op === 'wait' || step.op === 'disconnect') {
      lines.push({ text: describeStep(step), exchanges: [] });
      continue;
    }
    lines.push({
      text: describeStep(step),
      exchanges: where(
        (e) =>
          methodsOf(e).includes(step.op) &&
          (step.op !== 'tools/call' ||
            (e.body ?? '').includes(`"name":"${step.name}"`) ||
            e.headers['mcp-name'] === step.name)
      )
    });
  }
  return lines;
}

function checklist(data: CellPageData, failedAt: ReadonlySet<number>): string {
  const { exchanges } = data.traffic;
  const lines = stepLines(data, exchanges);
  if (!lines.length) return '';
  const items = lines.map((line) => {
    const bad = line.exchanges.some((i) => failedAt.has(i));
    const done = line.exchanges.length > 0;
    const glyph = bad ? '✗' : done ? '✓' : '○';
    const word = bad ? 'failed' : done ? 'seen' : 'not seen yet';
    const links = line.exchanges
      .slice(0, 8)
      .map((i) => `<a href="#x${i + 1}">#${i + 1}</a>`)
      .join(', ');
    const more =
      line.exchanges.length > 8 ? ` and ${line.exchanges.length - 8} more` : '';
    return (
      `<li><span class=glyph aria-hidden=true>${glyph}</span> <span class=muted>${word}:</span> ` +
      `${esc(line.text)}${links ? ` <span class=muted>${links}${more}</span>` : ''}</li>`
    );
  });
  return (
    `<h2>Steps of this scenario</h2><p class=muted>What a client does here, each tied to the ` +
    `exchanges that did it. A step your client skips may be fine: the checks decide.</p>` +
    `<ul class=checklist>${items.join('')}</ul>`
  );
}

function trafficTable(
  data: CellPageData,
  failedAt: ReadonlyMap<number, string>,
  trafficUrl: string | undefined
): string {
  const { exchanges, omitted } = data.traffic;
  const download = trafficUrl
    ? ` <a href="${esc(trafficUrl)}" download>Download traffic (JSON lines)</a>`
    : '';
  if (!exchanges.length) {
    return (
      `<h2 id=traffic>Traffic</h2><p class=muted>No request has reached this ` +
      `attempt yet.${download}</p>`
    );
  }
  const conns = connectionNumbers(exchanges);
  const rows: string[] = [];
  let prev: Exchange | undefined;
  const opened = new Set<number>();
  exchanges.forEach((e, i) => {
    if (prev) {
      const gap = Date.parse(e.at) - Date.parse(prev.at) - (prev.ms ?? 0);
      if (gap >= GAP_MS)
        rows.push(
          `<tr class=note><td colspan=10>${esc(gapText(gap))} with no request.</td></tr>`
        );
    }
    const n = e.conn !== undefined ? conns.get(e.conn) : undefined;
    if (n !== undefined && !opened.has(n)) {
      opened.add(n);
      if (conns.size > 1)
        rows.push(
          `<tr class=note><td colspan=10>Connection ${n} opens${
            e.conn?.startsWith('s:')
              ? ` (MCP session <code>${esc(e.conn.slice(2, 14))}</code>)`
              : ''
          }.</td></tr>`
        );
    }
    const lanes = LANES.map(
      (l) =>
        `<td class="lane${l === e.lane ? ' on' : ''}" title="${esc(LANE_TITLE[l])}">${
          l === e.lane ? '●' : '·'
        }</td>`
    ).join('');
    const rpc = rpcText(e);
    const failed = failedAt.get(i);
    const marks = [
      failed ? `<b>✗ check failed here</b> <code>${esc(failed)}</code>` : '',
      e.refused
        ? `↺ ${esc(REFUSED_TEXT[e.refused])} issued before the reset, refused`
        : '',
      e.repeats ? `×${e.repeats + 1}` : ''
    ].filter(Boolean);
    const summary =
      `${esc(e.method)} ${esc(e.path.length > 90 ? e.path.slice(0, 90) + '…' : e.path)}` +
      (rpc ? ` · ${esc(rpc)}` : '') +
      (e.role && e.role !== 'as'
        ? ` <span class=muted>(${esc(e.role)})</span>`
        : '');
    rows.push(
      `<tr id=x${i + 1}${failed ? ' class=bad' : ''}><td class=num>${i + 1}</td>${lanes}` +
        `<td class=t>${esc(time(e.at))}</td><td class=num>${n ?? '–'}</td>` +
        `<td><details id=xd${i + 1}><summary>${summary}</summary>${exchangeText(e)}</details>` +
        `${marks.length ? `<div>${marks.join(' · ')}</div>` : ''}</td>` +
        `<td>${esc(e.headers['mcp-protocol-version'] ?? '–')}</td>` +
        `<td>${esc(e.authorization)}</td><td class=num>${esc(statusText(e.status))}</td></tr>`
    );
    prev = e;
  });
  const cut = omitted
    ? `<p class=muted>${omitted} more exchange${omitted === 1 ? ' was' : 's were'} not kept: ` +
      `a cell keeps at most 150 per process and attempt.</p>`
    : '';
  const lanesKey = LANES.map((l) => `●&nbsp;${esc(LANE_TITLE[l])}`).join(' · ');
  return (
    `<h2 id=traffic>Traffic: ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}` +
    `${conns.size > 1 ? ` on ${conns.size} connections` : ''}</h2>` +
    `<p class=muted>Every request your client sent this cell, in order. The three columns after # say ` +
    `where it went, left to right: ${lanesKey}. Authorization only ever reads present or absent, ` +
    `never its value. Open a row for its headers and bodies.${download}</p>` +
    `<table class=traffic><tr><th>#</th><th colspan=3>to</th><th>time (UTC)</th><th>conn</th>` +
    `<th>request</th><th>MCP-Protocol-Version</th><th>Authorization</th><th>status</th></tr>` +
    rows.join('') +
    `</table>${cut}`
  );
}

function checkItem(
  c: ShownCheck,
  data: CellPageData,
  at: (c: ConformanceCheck) => number | undefined
): string {
  const glyph = c.notSeen ? '○' : CHECK_GLYPH[c.status];
  const word = c.notSeen ? 'not seen' : c.status.toLowerCase();
  const refs = refsHtml(c, data.ref.revision);
  const said = c.reason ?? c.description;
  return (
    `<li><span class=pill style="${STATUS_STYLE[c.notSeen ? 'SKIPPED' : c.status]}">` +
    `<span aria-hidden=true>${glyph}</span> ${esc(word)}</span> <code>${esc(c.id)}</code> ` +
    `${esc(said ?? '')}${c.repeats ? ` <span class=muted>recorded ${c.repeats} times</span>` : ''}` +
    `${exchangeLink(at(c), data.traffic.exchanges)}${refs ? ` <span class=muted>${refs}</span>` : ''}` +
    // A row led by its reason keeps what the check is about below it.
    (c.reason && about(c) ? `<div class=muted>${about(c)}</div>` : '') +
    (c.details || c.errorMessage
      ? `<details><summary>details</summary><pre>${esc(
          JSON.stringify(
            { errorMessage: c.errorMessage, ...c.details },
            null,
            2
          )
        )}</pre></details>`
      : '') +
    `</li>`
  );
}

function checkSections(
  data: CellPageData,
  at: (c: ConformanceCheck) => number | undefined
): string {
  const listed = data.shown.filter(
    (c) => !LOG_ROW.test(c.id) && !UNLISTED.has(c.id)
  );
  const list = (rows: ShownCheck[]) =>
    `<ul class=checklist>${rows.map((c) => checkItem(c, data, at)).join('')}</ul>`;
  const failing = listed.filter((c) => c.status === 'FAILURE' && !c.notSeen);
  const waiting = listed.filter((c) => c.notSeen);
  const warnings = listed.filter((c) => c.status === 'WARNING' && !c.notSeen);
  const passed = listed.filter((c) => c.status === 'SUCCESS');
  const other = listed.filter(
    (c) => c.status === 'SKIPPED' || c.status === 'INFO'
  );
  const out: string[] = [];
  if (failing.length) out.push(`<h2>Failed checks</h2>${list(failing)}`);
  if (waiting.length)
    out.push(
      `<h2>Not seen yet</h2><p class=muted>The scenario still expects these; nothing ` +
        `your client did has failed them.</p>${list(waiting)}`
    );
  if (warnings.length) out.push(`<h2>Warnings</h2>${list(warnings)}`);
  if (passed.length)
    out.push(
      `<details class=section><summary>✓ ${passed.length} passed check${
        passed.length === 1 ? '' : 's'
      }</summary>${list(passed)}</details>`
    );
  if (other.length)
    out.push(
      `<details class=section><summary>${other.length} note${
        other.length === 1 ? '' : 's'
      } and skipped check${other.length === 1 ? '' : 's'}</summary>${list(other)}</details>`
    );
  return out.join('');
}

function setupSection(data: CellPageData, live: CellPageLive): string {
  const cell = live.config;
  const runPage = `/s/${esc(data.ref.runId)}`;
  if (!cell) {
    return `<details class=section id=setup><summary>Set-up</summary><p class=muted>${esc(
      data.status.startReason ??
        data.status.reason ??
        'This cell cannot be started here.'
    )}</p></details>`;
  }
  const steps = cell.steps
    ? `<h3>Steps</h3><p class=muted>What to make the client do here. A generic client reads the same steps from <code>MCP_CONFORMANCE_CONTEXT.steps</code>.</p>${stepsOpen(
        cell.steps
      )}`
    : authSteps(data.ref.scenarioName)
        .replace(/<h2>/g, '<h3>')
        .replace(/<\/h2>/g, '</h3>');
  const picker = configPicker(
    [{ name: serverName(cell.revision, cell.scenario), url: cell.url }],
    {
      urlPanel: `<pre>${esc(cell.url)}</pre><div class=actions><button class=copy data-copy-text="${esc(
        cell.url
      )}">copy URL</button></div>`
    }
  );
  return (
    `<details class=section id=setup><summary>Set-up: the MCP URL, steps and credentials</summary>` +
    `<h3>MCP endpoint</h3>${picker}` +
    `<p class=muted>Every cell of the run, and composites that carry several, are on ` +
    `<a href="${runPage}">the run page</a>.</p>` +
    handNote(data.ref.scenarioName) +
    credentials(cell)
      .replace(/<h2>/g, '<h3>')
      .replace(/<\/h2>/g, '</h3>') +
    steps +
    `<h3>Environment</h3><p class=muted>What the CLI runner would set for a scripted client.</p>${envPre(cell)}` +
    `</details>`
  );
}

/** The cell's page, live (`live`) or as a frozen copy (`frozen`). */
export function renderCell(
  data: CellPageData,
  opts: {
    live?: CellPageLive;
    frozen?: CellPageFrozen;
    build?: BuildInfo | null;
  }
): string {
  const { ref } = data;
  const run = esc(ref.runId);
  const cellPath = `${esc(ref.runId)}/${esc(ref.revision)}/${esc(ref.scenarioName)}`;
  const at = linker(data.traffic.exchanges);
  const failedAt = new Map<number, string>();
  for (const c of data.shown) {
    if (c.status !== 'FAILURE' || c.notSeen) continue;
    const i = at(c);
    if (i !== undefined && !failedAt.has(i)) failedAt.set(i, c.id);
  }
  const frozen = opts.frozen;
  const live = opts.live;
  const reportUrl = frozen
    ? `/results/${run}/snapshot/${esc(frozen.snapshotId)}`
    : `/results/${run}`;
  const trafficUrl = frozen
    ? `/results/${run}/snapshot/${esc(frozen.snapshotId)}/${esc(ref.revision)}/${esc(ref.scenarioName)}/traffic.jsonl`
    : `/results/${cellPath}/traffic.jsonl`;
  const crumbs =
    `<p class=crumbs><a href="/s/${run}">run <code>${run}</code></a> › ` +
    `<a href="${reportUrl}">results${frozen ? ` (frozen ${esc(utcMinute(frozen.frozenAt))})` : ''}</a> › ` +
    `<a href="/results/${run}/${esc(ref.revision)}">${esc(ref.revision)}</a> › <code>${esc(ref.scenarioName)}</code></p>`;
  const url = data.mcpUrl
    ? `<p>MCP URL <code>${esc(data.mcpUrl)}</code> <button class=copy data-copy-text="${esc(
        data.mcpUrl
      )}">copy URL</button>${live ? ' <a href="#setup">set-up and steps ↓</a>' : ''}</p>`
    : '';
  const frozenNote = frozen
    ? `<p class=note>A frozen copy of this cell, taken ${esc(utcMinute(frozen.frozenAt))}: ` +
      `later traffic does not change it. <a href="/results/${cellPath}">The live page</a> has anything since.</p>`
    : '';
  const resetUrl =
    live?.resettable && !frozen ? `/results/${cellPath}/reset` : undefined;
  const body =
    `<h1><code>${esc(ref.scenarioName)}</code> <small>at ${esc(ref.revision)}</small></h1>` +
    crumbs +
    `<p>${prose(data.description, true)}</p>` +
    url +
    frozenNote +
    (frozen ? '' : liveNote) +
    `<div id=live>` +
    attemptsBlock(data, resetUrl) +
    verdictLine(data) +
    fixBlock(data, at) +
    checklist(data, new Set(failedAt.keys())) +
    trafficTable(data, failedAt, trafficUrl) +
    checkSections(data, at) +
    `</div>` +
    (live ? setupSection(data, live) + pickerScript : '') +
    (frozen ? '' : liveScript) +
    copyScript;
  return page(
    `${ref.scenarioName} at ${ref.revision} — ${ref.runId}`,
    `<style>${cellCss}</style>${body}`,
    opts.build
  );
}

/** A cell's page data without its judged rows' log rows, for JSON. */
export function earlierCause(
  shown: readonly ShownCheck[],
  note: string | undefined
): string | undefined {
  const failure = shown.find((c) => c.status === 'FAILURE' && !c.notSeen);
  if (failure) return `${failure.id}: ${failure.reason ?? failure.name}`;
  return note;
}

// Kept for the state pill's callers that want the glyph too.
export function glyphPill(state: CellState): string {
  return `<span aria-hidden=true>${STATE_GLYPH[state]}</span> ${statePill(state)}`;
}
