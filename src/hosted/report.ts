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
 * Per column, "scored X of N" counts passes among every cell the revision's
 * requirement set scores — N is the yaml's count, whether or not this
 * deployment can start the cell — and says separately how many of those N
 * are startable here; not_scored and unlisted cells are reported next to the
 * score, never inside it. Only FAILURE decides a verdict — INFO checks such
 * as the client identity the hosted layer records never do.
 */

import type { ConformanceCheck } from '../types';
import type { HostedMatrix, MatrixCell } from './matrix';
import { cellId, type CellRef, type RunResults } from './session';
import { identitiesIn, mergeIdentities, type ClientIdentity } from './identity';
import { shownChecks, type ShownCheck } from './shown';
import {
  findingsOf,
  groupCauses,
  legacyCauseKey,
  legacyStop,
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
 *
 * `pass`, `fail` and `n/a` are the verdict's. The score is never changed by
 * the state.
 */
export type CellState =
  | 'pass'
  | 'fail'
  | 'waiting'
  | 'in-progress'
  | 'incomplete'
  | 'not-tried'
  | 'not-startable'
  | 'n/a';

/** What a `waiting` cell's note says. */
export const WAITING_NOTE =
  'waiting for the client or the person to finish the flow';

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
  return legacyStop(checks) ? 'incomplete' : 'in-progress';
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
  results: Pick<RunResults, 'checks' | 'recorded'> | undefined
): CellView {
  const shown = results
    ? shownChecks(cell.scenario, cell.revision, results.checks)
    : undefined;
  const judged = verdictFor(cell, results?.checks, results?.recorded);
  const state = stateOf(cell, judged, shown);
  // Every failure only "not seen": nothing the client did has failed, so
  // the cell is not done rather than failed. Neither verdict scores.
  const verdict: Verdict = state === 'waiting' ? 'incomplete' : judged;
  const note =
    state === 'waiting'
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

/** Said when a legacy initialize is all the cell has seen of the client. */
function legacyOnly(checks: readonly ConformanceCheck[]): string | undefined {
  const stop = legacyStop(checks);
  if (!stop) return undefined;
  return stop.asked
    ? `the client spoke ${stop.asked} only (it opened with initialize) and did not retry at ${stop.served}`
    : `the client only sent initialize, the legacy handshake, and did not retry at ${stop.served}`;
}

export interface ReportSources {
  /** Cells of the run that were exercised (in memory or in the store). */
  listCells(runId: string): Promise<CellRef[]>;
  results(
    id: string
  ): Promise<Pick<RunResults, 'checks' | 'recorded'> | undefined>;
  resultsUrl(ref: CellRef): string;
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
      const { verdict, state, note, shown } = viewCell(cell, results);
      const stop = results ? legacyStop(results.checks) : undefined;
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
            state === 'waiting' && f.by === 'scenario'
              ? { ...f, cause: undefined }
              : f
          )
        : undefined;
      const stoppedBy =
        state === 'incomplete' && stop ? legacyCauseKey(stop) : undefined;
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
    causes: groupCauses(reached)
  };
}
