/**
 * Verdicts for a run: the matrix with a result per cell.
 *
 *   pass        checks recorded, none FAILURE
 *   fail        any FAILURE seen in the client's traffic
 *   incomplete  the cell exists but nothing was recorded, or it was never
 *               hit, or its only FAILUREs are ones not seen yet (a step the
 *               flow has not reached)
 *   n/a         the scenario does not apply to the revision
 *
 * Each cell also has a `state` that splits `incomplete` into not tried, in
 * progress and incomplete (see CellState), and, once the client reached it,
 * its failures and warnings one line each; the run's are grouped by cause
 * (see ./findings.ts). The verdict itself is unchanged by either.
 *
 * Per column, `scored` counts passes among every cell the revision's
 * requirement set scores — N is the yaml's count, whether or not this
 * deployment can start the cell — and says separately how many of those N
 * are startable here; not_scored and unlisted cells are reported next to the
 * score, never inside it. Only FAILURE decides a verdict — INFO checks such
 * as the client identity the hosted layer records never do.
 */

import type { ConformanceCheck } from '../types';
import type { Step } from '../steps';
import type { HostedMatrix, MatrixCell } from './matrix';
import { cellId, type CellRef, type RunResults } from './session';
import { identitiesIn, mergeIdentities, type ClientIdentity } from './identity';
import { shownChecks, type ShownCheck } from './shown';
import type { BuildInfo } from './build';
import {
  awaitingSignIn,
  eraStop,
  eraStopText,
  findingsOf,
  groupCauses,
  legacyStop,
  stopCauseKey,
  type Cause,
  type CellFindings,
  type Finding
} from './findings';

export type Verdict = 'pass' | 'fail' | 'incomplete' | 'n/a';

/**
 * Where a cell stands, finer than its verdict: `incomplete` is split by
 * whether the client got there at all.
 *
 *   not-tried      no request reached the cell
 *   in-progress    the client reached it but has not yet done anything its
 *                  scenario tests (it lists what it is waiting for)
 *   incomplete     the client reached it and stopped before the scenario
 *                  could test anything, for a reason the server saw: it spoke
 *                  only an older revision and did not retry
 *   not-startable  this deployment cannot start the cell
 *
 * and one more whose checks were judged:
 *
 *   waiting        every FAILURE is "not seen" — the scenario's own
 *                  expectation that nothing has met yet (see ./shown.ts),
 *                  none from the client's traffic: an auth flow sitting on a
 *                  consent screen, an elicitation form still to answer. Its
 *                  verdict is `incomplete`, not `fail` (see viewCell()).
 *   stopped        a waiting cell whose client has sent nothing for
 *                  STOPPED_AFTER_MS, with no step a person is known to be
 *                  taking (a sign-in page opened, a form handed over and not
 *                  answered): the client most likely crashed or gave up. Its
 *                  verdict is `incomplete` too; only the label differs.
 *
 * `pass`, `fail` and `n/a` are the verdict's. The score is never changed by
 * the state.
 */
export type CellState =
  | 'pass'
  | 'fail'
  | 'waiting'
  | 'stopped'
  | 'in-progress'
  | 'incomplete'
  | 'not-tried'
  | 'not-startable'
  | 'n/a';

/** What a `waiting` cell's note says. */
export const WAITING_NOTE =
  'waiting for the client or the person to finish the flow';

/** How long a waiting cell's client may be silent before it reads stopped. */
export const STOPPED_AFTER_MS = 60_000;

/** What a `stopped` cell's note says, `quietMs` after the last request. */
export function stoppedNote(quietMs: number): string {
  const minutes = Math.floor(quietMs / 60_000);
  return `stopped: no request from your client for ${minutes} minute${minutes === 1 ? '' : 's'}; re-run it`;
}

/** What a cell's results say, as the pages read them. */
export type CellResults = Pick<
  RunResults,
  'checks' | 'recorded' | 'lastRequestAt' | 'awaitingInput'
>;

/**
 * How long a waiting cell's client has been silent at `now`, in ms, when
 * that means it stopped: STOPPED_AFTER_MS or more since its last request,
 * with no step a person is known to be taking — a sign-in page opened and
 * no token asked for, or a form handed over and not answered. Undefined
 * otherwise, including when no request time is known.
 */
export function stoppedFor(
  results: Pick<CellResults, 'checks' | 'lastRequestAt' | 'awaitingInput'>,
  now: number
): number | undefined {
  const quiet = now - Date.parse(results.lastRequestAt ?? '');
  if (!(quiet >= STOPPED_AFTER_MS)) return undefined;
  if (results.awaitingInput || awaitingSignIn(results.checks)) return undefined;
  return quiet;
}

/** `checks` as shown (./shown.ts), so a "not seen" row can be told apart. */
export function stateOf(
  cell: Pick<MatrixCell, 'scoring' | 'startable'>,
  verdict: Verdict,
  checks: readonly ShownCheck[] | undefined
): CellState {
  if (verdict === 'fail' && checks && onlyNotSeen(checks)) return 'waiting';
  if (verdict !== 'incomplete') return verdict;
  if (!cell.startable) return 'not-startable';
  if (!checks) return 'not-tried';
  return legacyStop(checks) || eraStop(checks) ? 'incomplete' : 'in-progress';
}

function onlyNotSeen(checks: readonly ShownCheck[]): boolean {
  const failures = checks.filter((c) => c.status === 'FAILURE');
  return failures.length > 0 && failures.every((c) => c.notSeen);
}

/** A cell's results as every page shows them: rows, verdict, state, note. */
export interface CellView {
  verdict: Verdict;
  state: CellState;
  /** On a startable incomplete cell or a waiting one: why, in plain words. */
  note?: string;
  /** The rows (./shown.ts); absent when the cell was never exercised. */
  shown?: ShownCheck[];
}

export function viewCell(
  cell: Pick<MatrixCell, 'scenario' | 'revision' | 'scoring' | 'startable'>,
  results: CellResults | undefined,
  now: number = Date.now()
): CellView {
  const shown = results
    ? shownChecks(cell.scenario, cell.revision, results.checks)
    : undefined;
  const judged = verdictFor(cell, results?.checks, results?.recorded);
  const stood = stateOf(cell, judged, shown);
  // A waiting cell whose client has gone quiet, with no step a person is
  // known to be taking, has stopped: said so, so nobody waits on it.
  const quiet =
    stood === 'waiting' && results ? stoppedFor(results, now) : undefined;
  const state: CellState = quiet === undefined ? stood : 'stopped';
  // Every failure only "not seen": nothing the client did has failed, so
  // the cell is not done rather than failed. Neither verdict scores.
  const verdict: Verdict =
    state === 'waiting' || state === 'stopped' ? 'incomplete' : judged;
  const note =
    quiet !== undefined
      ? stoppedNote(quiet)
      : state === 'waiting'
        ? WAITING_NOTE
        : verdict === 'incomplete' && cell.startable
          ? incompleteNote(shown ?? [])
          : undefined;
  return { verdict, state, ...(note && { note }), ...(shown && { shown }) };
}

export interface CheckSummary {
  passed: number;
  /** FAILUREs seen in the client's traffic. */
  failed: number;
  /**
   * FAILUREs that are the scenario's own expectations nothing has met yet
   * (the flow did not reach the step): a FAILURE row, but not the client's.
   */
  notSeen: number;
  warnings: number;
  info: number;
  skipped: number;
  total: number;
}

export interface CellReport {
  scenario: string;
  revision: string;
  scoring: MatrixCell['scoring'];
  reason?: string;
  startable: boolean;
  startReason?: string;
  verdict: Verdict;
  /** Where the cell stands, finer than the verdict (see CellState). */
  state: CellState;
  /**
   * On a startable incomplete cell: why, in plain words (incompleteNote()).
   * On a waiting cell: WAITING_NOTE.
   */
  note?: string;
  /** Absent when the cell was never exercised or does not apply. */
  summary?: CheckSummary;
  /**
   * On a cell the client reached: its failures and warnings, one line each,
   * marked client or scenario. On an `in-progress` cell they are only what
   * the scenario is still waiting for.
   */
  findings?: Finding[];
  /** On an `incomplete` cell: the cause that stopped it (RunReport.causes). */
  cause?: string;
  resultsUrl: string;
  identities?: ClientIdentity[];
  /**
   * On a `not-tried` cell as served (withNotTriedHints()), never stored:
   * the cell's MCP URL, and what the client must do there.
   */
  mcpUrl?: string;
  hint?: string;
}

export interface ColumnReport {
  revision: string;
  /**
   * Passes among the cells the requirement set scores, out of all of them
   * (`total`, the yaml's count), with how many of those this deployment
   * can start (`startable`).
   */
  scored: { passed: number; total: number; startable: number };
  cells: CellReport[];
  /** The not_scored / unlisted cells that were exercised, with verdicts. */
  notScored: CellReport[];
  /** How many of the column's cells stand where, n/a cells left out. */
  counts: Partial<Record<CellState, number>>;
  identities: ClientIdentity[];
}

export interface RunReport {
  runId: string;
  revision?: string;
  /** When the report was built (ISO 8601). */
  generatedAt: string;
  columns: ColumnReport[];
  /** Every client identity seen anywhere in the run. */
  identities: ClientIdentity[];
  /**
   * Every grouped finding said once, with the cells it covers: client
   * causes first, then those covering the most cells (see ./findings.ts).
   */
  causes: Cause[];
  /** On a frozen copy (POST /results/<run-id>/freeze): its id and time. */
  snapshotId?: string;
  frozenAt?: string;
  /**
   * The server build that produced the report (see ./build.ts): stored with
   * a frozen copy, so it says which build it came from. Absent on a copy
   * frozen before builds were recorded.
   */
  server?: BuildInfo;
}

/** A finding as the run report's JSON gives it (see reportJson()). */
export interface JsonFinding extends Omit<Finding, 'status'> {
  status: Finding['status'] | 'NOT_SEEN';
}

type JsonCell = Omit<CellReport, 'findings'> & { findings?: JsonFinding[] };

export interface JsonRunReport extends Omit<RunReport, 'columns'> {
  columns: (Omit<ColumnReport, 'cells' | 'notScored'> & {
    cells: JsonCell[];
    notScored: JsonCell[];
    /** Startable cells nothing reached (see groupColumn()). */
    notTried: JsonCell[];
    /** Cells this deployment cannot start (see groupColumn()). */
    unavailable: JsonCell[];
  })[];
}

/**
 * The run report as its JSON gives it: a FAILURE that is the scenario's own
 * expectation not yet met (`by: "scenario"`) reads NOT_SEEN, as a cell's
 * rows do (./shown.ts jsonRows()), and each column adds its `notTried` and
 * `unavailable` cells as lists of their own (`cells` still has every cell).
 * Presentation only: the HTML, the Markdown, the causes, every count and a
 * frozen copy's stored form are built from the report as it is.
 */
export function reportJson(report: RunReport): JsonRunReport {
  const cell = (c: CellReport): JsonCell =>
    c.findings
      ? {
          ...c,
          findings: c.findings.map((f) =>
            f.by === 'scenario' && f.status === 'FAILURE'
              ? { ...f, status: 'NOT_SEEN' }
              : f
          )
        }
      : c;
  return {
    ...report,
    columns: report.columns.map((col) => {
      const { notTried, unavailable } = groupColumn(col);
      return {
        ...col,
        cells: col.cells.map(cell),
        notScored: col.notScored.map(cell),
        notTried: notTried.map(cell),
        unavailable: unavailable.map(cell)
      };
    })
  };
}

/**
 * A column's cells in the order every form of the report lists them, n/a
 * cells left out: what needs a look, what the client has not tried, what
 * passed; and apart, what this deployment cannot start.
 */
export interface ColumnGroups {
  /** Reached, not passing: fail, then waiting, in progress, incomplete. */
  problems: CellReport[];
  /** Startable cells no request reached. */
  notTried: CellReport[];
  passed: CellReport[];
  /** Cells this deployment cannot start (and nothing reached). */
  unavailable: CellReport[];
}

const PROBLEMS: readonly CellState[] = [
  'fail',
  'waiting',
  'stopped',
  'in-progress',
  'incomplete'
];

/**
 * Grouped by `state` alone, so a frozen copy stored before the groups
 * existed is grouped the same way when it is read.
 */
export function groupColumn(col: Pick<ColumnReport, 'cells'>): ColumnGroups {
  const of = (state: CellState) => col.cells.filter((c) => c.state === state);
  return {
    problems: PROBLEMS.flatMap(of),
    notTried: of('not-tried'),
    passed: of('pass'),
    unavailable: of('not-startable')
  };
}

/** A scenario this deployment cannot start, once for all its revisions. */
export interface UnavailableScenario {
  scenario: string;
  revisions: string[];
  reason: string;
}

export function unavailableScenarios(
  report: Pick<RunReport, 'columns'>
): UnavailableScenario[] {
  const out = new Map<string, UnavailableScenario>();
  for (const col of report.columns) {
    for (const c of groupColumn(col).unavailable) {
      const reason = c.startReason ?? '';
      const key = `${c.scenario}\n${reason}`;
      const seen = out.get(key);
      if (seen) seen.revisions.push(c.revision);
      else {
        out.set(key, { scenario: c.scenario, revisions: [c.revision], reason });
      }
    }
  }
  return Array.from(out.values());
}

/** Auth scenarios whose client gets its token without a sign-in page. */
export const NO_SIGN_IN =
  /^auth\/(client-credentials-|wif-|enterprise-managed-)/;

/** How many of a cell's steps a hint names before "and N more". */
const HINT_STEPS = 3;

/** A step described longer than this names its tool without arguments. */
const HINT_STEP_CHARS = 60;

/**
 * What a client must do at a cell, in a line: its steps when it has them,
 * else the sign-in for an auth cell, else what the scenario tests. `describe`
 * is ../steps describeStep(), passed in so this module does not load the
 * step schemas (see ./server.ts pages()).
 */
export function notTriedHint(
  cell: Pick<MatrixCell, 'scenario' | 'steps'>,
  description: string,
  describe: (step: Step) => string
): string {
  const steps = cell.steps ?? [];
  if (steps.length) {
    const short = (step: Step) => {
      const said = describe(step);
      return step.op === 'tools/call' && said.length > HINT_STEP_CHARS
        ? `call ${step.name} with the arguments on the cell’s page`
        : said;
    };
    const named = steps.slice(0, HINT_STEPS).map(short);
    const more = steps.length - named.length;
    return (
      `connect, then ${named.join(', then ')}` +
      (more ? `, and ${more} more step${more === 1 ? '' : 's'}` : '')
    );
  }
  if (cell.scenario.startsWith('auth/')) {
    return NO_SIGN_IN.test(cell.scenario)
      ? 'connect; it gets its token itself, with the credentials the cell gives it'
      : 'connect and approve the sign-in (the test authorization server approves at once), then list the tools';
  }
  const what = description
    .split('\n')[0]
    .trim()
    .replace(/^tests?\s+/i, '');
  return what ? `connect; the cell tests ${what}` : 'connect';
}

/**
 * The report with each not-tried cell's MCP URL and hint added, for the
 * page and every export. Never stored: a frozen copy gets them when it is
 * read, at the host it is read through, like its results links.
 */
export function withNotTriedHints(
  report: RunReport,
  matrix: HostedMatrix,
  cellUrl: (ref: CellRef) => string,
  describe: (step: Step) => string
): RunReport {
  const descriptions = new Map(
    matrix.rows.map((r) => [r.scenario, r.description])
  );
  const add = (c: CellReport): CellReport => {
    const cell =
      c.state === 'not-tried' ? matrix.cell(c.scenario, c.revision) : undefined;
    if (!cell) return c;
    const ref: CellRef = {
      runId: report.runId,
      revision: cell.revision,
      scenarioName: cell.scenario
    };
    return {
      ...c,
      mcpUrl: `${cellUrl(ref)}${cell.mcpPath}`,
      hint: notTriedHint(cell, descriptions.get(c.scenario) ?? '', describe)
    };
  };
  return {
    ...report,
    columns: report.columns.map((col) => ({
      ...col,
      cells: col.cells.map(add)
    }))
  };
}

/** Counts over a cell's rows as shown (see ./shown.ts): a repeat is one. */
export function summarize(checks: readonly ShownCheck[]): CheckSummary {
  const counts = { SUCCESS: 0, FAILURE: 0, WARNING: 0, SKIPPED: 0, INFO: 0 };
  let notSeen = 0;
  for (const c of checks) {
    if (c.status === 'FAILURE' && c.notSeen) notSeen++;
    else counts[c.status]++;
  }
  return {
    passed: counts.SUCCESS,
    failed: counts.FAILURE,
    notSeen,
    warnings: counts.WARNING,
    info: counts.INFO,
    skipped: counts.SKIPPED,
    total: checks.length
  };
}

/**
 * `recorded` is what the scenario itself observed; judgement may add
 * "expected but never seen" failures to `checks`, which must not turn a cell
 * nobody talked to into a `fail`.
 */
export function verdictFor(
  cell: Pick<MatrixCell, 'scoring'>,
  checks: ConformanceCheck[] | undefined,
  recorded: number = checks?.length ?? 0
): Verdict {
  if (cell.scoring === 'n/a') return 'n/a';
  if (!checks || recorded === 0) return 'incomplete';
  return checks.some((c) => c.status === 'FAILURE') ? 'fail' : 'pass';
}

/**
 * Why a startable cell reads `incomplete`, in plain words. Every FAILURE on
 * an incomplete cell is one of the scenario's expectations that nothing has
 * met yet ("Tool was not called by client"; see verdictFor()), so the counts
 * shown beside the verdict are what the scenario is still waiting for.
 */
export function incompleteNote(checks: readonly ConformanceCheck[]): string {
  if (!checks.length) {
    return 'nothing recorded yet — point the client at the MCP endpoint';
  }
  const waiting = checks.filter((c) => c.status === 'FAILURE').length;
  const lead =
    legacyOnly(checks) ??
    'the client has not yet done anything this scenario tests';
  if (!waiting) return lead;
  return waiting === 1
    ? `${lead}; the failure listed is what it is still waiting for`
    : `${lead}; the ${waiting} failures listed are what it is still waiting for`;
}

/**
 * Said when a legacy initialize, or requests at another revision that the
 * cell turned away (eraStop()), are all the cell has seen of the client.
 */
function legacyOnly(checks: readonly ConformanceCheck[]): string | undefined {
  const stop = legacyStop(checks);
  if (!stop) {
    const era = eraStop(checks);
    return era && eraStopText(era);
  }
  return stop.asked
    ? `the client spoke ${stop.asked} only (it opened with initialize) and did not retry at ${stop.served}`
    : `the client only sent initialize, the legacy handshake, and did not retry at ${stop.served}`;
}

export interface ReportSources {
  /** Cells of the run that were exercised (in memory or in the store). */
  listCells(runId: string): Promise<CellRef[]>;
  results(id: string): Promise<CellResults | undefined>;
  resultsUrl(ref: CellRef): string;
  /** The server build, recorded in the report (RunReport.server). */
  build?: BuildInfo;
  /** The time the report is built at (ms); defaults to the clock. */
  now?: () => number;
}

export async function buildReport(
  matrix: HostedMatrix,
  runId: string,
  revision: string | undefined,
  sources: ReportSources
): Promise<RunReport> {
  const exercised = new Set(
    (await sources.listCells(runId)).map((ref) => cellId(ref))
  );
  const columns: ColumnReport[] = [];
  const now = sources.now?.() ?? Date.now();
  const allIdentities = new Map<string, ClientIdentity>();
  const reached: CellFindings[] = [];

  for (const rev of matrix.revisions) {
    if (revision !== undefined && rev !== revision) continue;
    const cells: CellReport[] = [];
    const identities = new Map<string, ClientIdentity>();
    for (const row of matrix.rows) {
      const cell = matrix.cell(row.scenario, rev)!;
      const ref: CellRef = {
        runId,
        revision: cell.revision,
        scenarioName: cell.scenario
      };
      const id = cellId(ref);
      const results =
        cell.scoring !== 'n/a' && exercised.has(id)
          ? await sources.results(id)
          : undefined;
      const seen = results ? identitiesIn(results.checks) : [];
      mergeIdentities(identities, seen);
      mergeIdentities(allIdentities, seen);
      const { verdict, state, note, shown } = viewCell(cell, results, now);
      // What stopped the client: a legacy handshake, or (on a cell that
      // reads incomplete for it) requests at another revision turned away.
      const stop = results
        ? (legacyStop(results.checks) ??
          (state === 'incomplete' ? eraStop(results.checks) : undefined))
        : undefined;
      // An in-progress cell's findings, and a waiting cell's not-seen ones,
      // are only what it waits for: listed on its row, never grouped as
      // causes (nothing went wrong yet).
      const findings = results
        ? findingsOf(
            cell.scenario,
            cell.revision,
            results.checks,
            stop,
            state !== 'in-progress'
          ).map((f) =>
            (state === 'waiting' || state === 'stopped') && f.by === 'scenario'
              ? { ...f, cause: undefined }
              : f
          )
        : undefined;
      const stoppedBy =
        state === 'incomplete' && stop ? stopCauseKey(stop) : undefined;
      if (results) {
        reached.push({
          cell: `${cell.revision}/${cell.scenario}`,
          findings: findings ?? [],
          ...(stop && { stop }),
          ...(stoppedBy && { stoppedBy })
        });
      }
      cells.push({
        scenario: cell.scenario,
        revision: cell.revision,
        scoring: cell.scoring,
        ...(cell.reason !== undefined && { reason: cell.reason }),
        startable: cell.startable,
        ...(cell.startReason !== undefined && {
          startReason: cell.startReason
        }),
        verdict,
        state,
        ...(note && { note }),
        ...(shown && { summary: summarize(shown) }),
        ...(findings?.length && { findings }),
        ...(stoppedBy && { cause: stoppedBy }),
        resultsUrl: sources.resultsUrl(ref),
        ...(seen.length && { identities: seen })
      });
    }
    const counts: Partial<Record<CellState, number>> = {};
    for (const c of cells) {
      if (c.state !== 'n/a') counts[c.state] = (counts[c.state] ?? 0) + 1;
    }
    const scoredCells = cells.filter((c) => c.scoring === 'scored');
    columns.push({
      revision: rev,
      scored: {
        passed: scoredCells.filter((c) => c.verdict === 'pass').length,
        total: scoredCells.length,
        startable: scoredCells.filter((c) => c.startable).length
      },
      cells,
      notScored: cells.filter(
        (c) =>
          (c.scoring === 'not_scored' || c.scoring === 'unlisted') &&
          c.summary !== undefined
      ),
      counts,
      identities: Array.from(identities.values())
    });
  }

  return {
    runId,
    ...(revision !== undefined && { revision }),
    generatedAt: new Date().toISOString(),
    columns,
    identities: Array.from(allIdentities.values()),
    causes: groupCauses(reached),
    ...(sources.build && { server: sources.build })
  };
}
