/**
 * Verdicts for a run: the matrix with a result per cell.
 *
 *   pass        checks recorded, none FAILURE
 *   fail        any FAILURE
 *   incomplete  the cell exists but nothing was recorded, or it was never hit
 *   n/a         the scenario does not apply to the revision
 *
 * Per column, "scored X of N" counts passes among the cells the revision's
 * requirement set scores AND this deployment can start; not_scored and
 * unlisted cells are reported next to the score, never inside it. Only
 * FAILURE decides a verdict — INFO checks such as the client identity the
 * hosted layer records never do.
 */

import type { ConformanceCheck } from '../types';
import type { HostedMatrix, MatrixCell } from './matrix';
import { cellId, type CellRef, type RunResults } from './session';
import { identitiesIn, type ClientIdentity } from './identity';

export type Verdict = 'pass' | 'fail' | 'incomplete' | 'n/a';

export interface CheckSummary {
  passed: number;
  failed: number;
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
  /** Absent when the cell was never exercised or does not apply. */
  summary?: CheckSummary;
  resultsUrl: string;
  identities?: ClientIdentity[];
}

export interface ColumnReport {
  revision: string;
  /** Passes among scored, startable cells / their number. */
  scored: { passed: number; total: number };
  cells: CellReport[];
  /** The not_scored / unlisted cells that were exercised, with verdicts. */
  notScored: CellReport[];
  identities: ClientIdentity[];
}

export interface RunReport {
  runId: string;
  revision?: string;
  columns: ColumnReport[];
  /** Every client identity seen anywhere in the run. */
  identities: ClientIdentity[];
}

export function summarize(checks: ConformanceCheck[]): CheckSummary {
  const counts = { SUCCESS: 0, FAILURE: 0, WARNING: 0, SKIPPED: 0, INFO: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    passed: counts.SUCCESS,
    failed: counts.FAILURE,
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
      for (const i of seen) {
        const key = JSON.stringify(i);
        identities.set(key, i);
        allIdentities.set(key, i);
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
        verdict: verdictFor(cell, results?.checks, results?.recorded),
        ...(results && { summary: summarize(results.checks) }),
        resultsUrl: sources.resultsUrl(ref),
        ...(seen.length && { identities: seen })
      });
    }
    const scoredCells = cells.filter(
      (c) => c.scoring === 'scored' && c.startable
    );
    columns.push({
      revision: rev,
      scored: {
        passed: scoredCells.filter((c) => c.verdict === 'pass').length,
        total: scoredCells.length
      },
      cells,
      notScored: cells.filter(
        (c) =>
          (c.scoring === 'not_scored' || c.scoring === 'unlisted') &&
          c.summary !== undefined
      ),
      identities: Array.from(identities.values())
    });
  }

  return {
    runId,
    ...(revision !== undefined && { revision }),
    columns,
    identities: Array.from(allIdentities.values())
  };
}
