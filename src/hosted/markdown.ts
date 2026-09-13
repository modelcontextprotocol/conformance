/**
 * The run report as Markdown, for pasting into an issue or a chat: who the
 * client is, the score, what went wrong once per cause, and a table of only
 * the cells the client reached, each failure marked as the client's or the
 * scenario's own. Anything that came from traffic (client names, check
 * messages) goes through mdText() or mdCode(), so it cannot open a link, a
 * tag, a code span or a new table cell when the Markdown is rendered.
 */

import type { CellReport, CellState, CheckSummary, RunReport } from './report';
import { NOT_REACHED, type Cause, type Finding } from './findings';
import type { ClientIdentity } from './identity';

export const STATE_LABEL: Record<CellState, string> = {
  pass: 'pass',
  fail: 'fail',
  waiting: 'waiting',
  'in-progress': 'in progress',
  incomplete: 'incomplete',
  'not-tried': 'not tried',
  'not-startable': 'not startable',
  'n/a': 'n/a'
};

/** States of a cell the client reached. */
export const REACHED: readonly CellState[] = [
  'pass',
  'fail',
  'waiting',
  'in-progress',
  'incomplete'
];

export const BY_LABEL: Record<Finding['by'], string> = {
  client: 'client',
  scenario: 'not seen'
};

/** How many causes' cells to name before "and N more". */
const CELLS_NAMED = 6;

/** One line of plain text, with the characters that start markup escaped. */
export function mdText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*[\]<>|]/g, (c) => `\\${c}`);
}

/** An identifier as a code span; `|` escaped so it stays in its table cell. */
export function mdCode(s: string): string {
  return '`' + s.replace(/[`\s]+/g, ' ').replace(/\|/g, '\\|') + '`';
}

/** `2026-09-13T21:47:05.123Z` → `2026-09-13 21:47 UTC`. */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function identityText(
  identities: readonly ClientIdentity[],
  text: (s: string) => string = mdText
): string {
  if (!identities.length) return 'no client seen yet';
  return identities
    .map((i) => {
      const who = i.name
        ? `${i.name}${i.version ? ` ${i.version}` : ''}`
        : 'unnamed client';
      const proto = i.protocolVersions.length
        ? ` (protocol ${i.protocolVersions.join(', ')})`
        : '';
      return text(who + proto);
    })
    .join('; ');
}

/** "3 pass, 1 fail, 2 in progress" over the states given. */
export function countsText(
  counts: RunReport['columns'][number]['counts'],
  states: readonly CellState[]
): string {
  return states
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${STATE_LABEL[s]}`)
    .join(', ');
}

/**
 * A cell's counts as its page leads with them: "1 passed, 0 failed, 6 not
 * seen". Only SUCCESS rows are passes; INFO rows (request logs) never count.
 */
export function countsLine(s: CheckSummary): string {
  const parts = [`${s.passed} passed`, `${s.failed} failed`];
  if (s.notSeen) parts.push(`${s.notSeen} not seen`);
  if (s.warnings) {
    parts.push(`${s.warnings} warning${s.warnings === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** 1-based number of each cause, for "(cause 2)" references. */
export function causeNumbers(causes: readonly Cause[]): Map<string, number> {
  return new Map(causes.map((c, i) => [c.key, i + 1]));
}

/**
 * The cause a cell's row should point at: the one that stopped it, or a
 * finding's when that cause covers other cells too.
 */
function causeRef(
  key: string | undefined,
  causes: ReadonlyMap<string, Cause>,
  numbers: ReadonlyMap<string, number>
): string {
  if (!key) return '';
  const cause = causes.get(key);
  if (!cause || cause.cells.length < 2) return '';
  return ` (cause ${numbers.get(key)})`;
}

/** One thing a waiting or in-progress cell has not seen yet. */
export interface Unmet {
  reason: string;
  /** The steps it covers, when the reason is only NOT_REACHED. */
  checks?: string[];
}

/**
 * What a waiting or in-progress cell has not seen yet: each distinct reason
 * once, and "the flow did not reach this step" as the steps it covers.
 */
export function waitingFor(cell: CellReport): Unmet[] {
  const unmet = (cell.findings ?? []).filter(
    (f) => cell.state === 'in-progress' || f.by === 'scenario'
  );
  const out: Unmet[] = [];
  for (const f of unmet) {
    if (f.reason === NOT_REACHED) {
      const steps = out.find((u) => u.checks);
      if (steps) steps.checks!.push(f.check);
      else out.push({ reason: f.reason, checks: [f.check] });
    } else if (!out.some((u) => u.reason === f.reason)) {
      out.push({ reason: f.reason });
    }
  }
  return out;
}

/** Whether a cell's row shows its pass / fail / warn counts. */
export function showsCounts(cell: CellReport): boolean {
  return ['pass', 'fail', 'waiting'].includes(cell.state);
}

/**
 * How text taken from traffic is written: as escaped Markdown, or as plain
 * text for a chat that renders no Markdown table (Slack), where it only has
 * to stay on one line.
 */
interface Style {
  text(s: string): string;
  code(s: string): string;
}

const MARKDOWN: Style = { text: mdText, code: mdCode };

const PLAIN: Style = {
  text: (s) => s.replace(/\s+/g, ' ').trim(),
  code: (s) => '`' + s.replace(/[`\s]+/g, ' ') + '`'
};

/** "the flow has not reached `a`, `b`", or the reason. */
function unmetText(u: Unmet, st: Style): string {
  return u.checks
    ? `the flow has not reached ${u.checks.map(st.code).join(', ')}`
    : st.text(u.reason);
}

/** What a passing cell's row says. */
export const NO_FINDINGS = 'no failures or warnings';

/**
 * Why an incomplete cell stopped: its note without the tail about the
 * failures its own page lists (incompleteNote() joins the two with "; ").
 */
export function stopNote(cell: CellReport): string {
  return (cell.note ?? '').split('; ')[0];
}

/** A reached cell's "what happened", one line per item. */
function happened(
  cell: CellReport,
  causes: ReadonlyMap<string, Cause>,
  numbers: ReadonlyMap<string, number>,
  st: Style
): string[] {
  const findings = cell.findings ?? [];
  if (cell.state === 'in-progress') {
    return [
      findings.length
        ? `waiting for: ${waitingFor(cell)
            .map((u) => unmetText(u, st))
            .join('; ')}`
        : st.text(cell.note ?? '')
    ];
  }
  if (cell.state === 'incomplete') {
    return [st.text(stopNote(cell)) + causeRef(cell.cause, causes, numbers)];
  }
  // A waiting cell's own expectations are what it waits for; anything the
  // client did (a warning) is listed as on any other row.
  const listed =
    cell.state === 'waiting'
      ? findings.filter((f) => f.by === 'client')
      : findings;
  const lines = listed.map(
    (f) =>
      `${f.status === 'WARNING' ? 'warning, ' : ''}${BY_LABEL[f.by]}: ` +
      `${st.code(f.check)} ${st.text(f.reason)}${causeRef(f.cause, causes, numbers)}`
  );
  if (cell.state === 'waiting') {
    lines.unshift(
      `${st.text(cell.note ?? '')}; not seen yet: ${waitingFor(cell)
        .map((u) => unmetText(u, st))
        .join('; ')}`
    );
  }
  return lines.length ? lines : [NO_FINDINGS];
}

export interface MarkdownLinks {
  /** The live report. */
  live: string;
  /** This frozen copy, when the report is one. */
  snapshot?: string;
}

/** The lines both forms open with: when, who, and the score per revision. */
function summaryLines(
  report: RunReport,
  links: MarkdownLinks,
  st: Style,
  bullet: string
): string[] {
  const out = [
    report.frozenAt && links.snapshot
      ? `${bullet}Frozen ${utcMinute(report.frozenAt)}: ${links.snapshot} (live report: ${links.live})`
      : `${bullet}As of ${utcMinute(report.generatedAt)}: ${links.live}`,
    `${bullet}Client: ${identityText(report.identities, st.text)}`
  ];
  for (const col of report.columns) {
    const reached = countsText(col.counts, REACHED);
    const notTried = col.counts['not-tried'] ?? 0;
    out.push(
      `${bullet}${col.revision}: ${col.scored.passed} of ${col.scored.total} scored cells pass ` +
        `(${col.scored.startable} startable here). ` +
        `Reached: ${reached || 'none'}` +
        (notTried ? `; ${notTried} not tried.` : '.')
    );
  }
  return out;
}

/** Each cause once, numbered, with the cells it covers. */
function causeLines(report: RunReport, st: Style): string[] {
  return report.causes.map((c, i) => {
    const cells = c.cells.slice(0, CELLS_NAMED).map(st.text).join(', ');
    const more =
      c.cells.length > CELLS_NAMED
        ? ` and ${c.cells.length - CELLS_NAMED} more`
        : '';
    const who = c.by === 'client' ? 'Client' : 'Not seen';
    return (
      `${i + 1}. ${who}: ${c.check ? `${st.code(c.check)} ` : ''}${st.text(c.text)} ` +
      `(${c.cells.length === 1 ? cells : `${c.cells.length} cells: ${cells}${more}`})`
    );
  });
}

function reachedCells(report: RunReport): CellReport[] {
  return report.columns.flatMap((col) =>
    col.cells.filter((c) => REACHED.includes(c.state))
  );
}

function countsOf(cell: CellReport): string {
  const s = cell.summary;
  return s && showsCounts(cell)
    ? `${s.passed} / ${s.failed} / ${s.warnings}`
    : '–';
}

const LEGEND =
  '"client" failures were seen in the client’s traffic; "not seen" ones are ' +
  'the scenario’s own expectations that nothing has met yet.';

export function reportMarkdown(
  report: RunReport,
  links: MarkdownLinks
): string {
  const causes = new Map(report.causes.map((c) => [c.key, c]));
  const numbers = causeNumbers(report.causes);
  const scope = report.revision ? ` at ${report.revision}` : '';
  const out = [
    `**MCP conformance: run ${mdCode(report.runId)}${scope}**`,
    '',
    ...summaryLines(report, links, MARKDOWN, '- ')
  ];
  if (report.causes.length) {
    out.push(
      '',
      '**What went wrong, by cause**',
      ...causeLines(report, MARKDOWN)
    );
  }
  const rows = reachedCells(report);
  if (rows.length) {
    out.push(
      '',
      '| Cell | Result | Pass / fail / warn | What happened |',
      '| --- | --- | --- | --- |'
    );
    for (const cell of rows) {
      out.push(
        `| [${mdText(`${cell.revision} ${cell.scenario}`)}](${cell.resultsUrl}) ` +
          `| ${STATE_LABEL[cell.state]} | ${countsOf(cell)} | ` +
          `${happened(cell, causes, numbers, MARKDOWN).join('<br>')} |`
      );
    }
    out.push('', LEGEND);
  } else {
    out.push('', 'No cell has been reached yet.');
  }
  return out.join('\n') + '\n';
}

/**
 * The same report as plain lines, for a chat that shows a Markdown table as
 * raw pipes (Slack): the summary, the causes, then one bullet per reached
 * cell with what happened under it.
 */
export function reportText(report: RunReport, links: MarkdownLinks): string {
  const causes = new Map(report.causes.map((c) => [c.key, c]));
  const numbers = causeNumbers(report.causes);
  const scope = report.revision ? ` at ${report.revision}` : '';
  const out = [
    `MCP conformance: run ${report.runId}${scope}`,
    ...summaryLines(report, links, PLAIN, '• ')
  ];
  if (report.causes.length) {
    out.push('', 'What went wrong, by cause', ...causeLines(report, PLAIN));
  }
  const rows = reachedCells(report);
  if (rows.length) {
    out.push('', 'Cells the client reached (pass / fail / warn)');
    for (const cell of rows) {
      const lines = happened(cell, causes, numbers, PLAIN);
      out.push(
        `• ${cell.revision} ${cell.scenario}: ${STATE_LABEL[cell.state]}, ${countsOf(cell)} — ${cell.resultsUrl}`,
        ...lines.map((l) => `    ◦ ${l}`)
      );
    }
    out.push('', LEGEND);
  } else {
    out.push('', 'No cell has been reached yet.');
  }
  return out.join('\n') + '\n';
}
