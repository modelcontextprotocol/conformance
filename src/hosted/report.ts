/**
 * Verdicts for a run: the matrix with a result per cell.
 *
 *   pass        checks recorded, none FAILURE
 *   fail        any FAILURE
 *   incomplete  the cell exists but nothing was recorded, or it was never hit
 *   n/a         the scenario does not apply to the revision
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
import {
  IDENTITY_CHECK_ID,
  identitiesIn,
  mergeIdentities,
  type ClientIdentity
} from './identity';
import { LEGACY_PROBE_CHECK_ID } from './wire';

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
  /** On a startable incomplete cell: why, in plain words (incompleteNote()). */
  note?: string;
  /** Absent when the cell was never exercised or does not apply. */
  summary?: CheckSummary;
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
  const probe = checks.find((c) => c.id === LEGACY_PROBE_CHECK_ID);
  if (!probe) return undefined;
  const served = String(probe.details?.served ?? '');
  const retried = checks.some(
    (c) =>
      c.id === IDENTITY_CHECK_ID &&
      Array.isArray(c.details?.protocolVersions) &&
      c.details.protocolVersions.includes(served)
  );
  if (retried) return undefined;
  const asked = probe.details?.requestedVersion;
  return typeof asked === 'string'
    ? `the client spoke ${asked} only (it opened with initialize) and did not retry at ${served}`
    : `the client only sent initialize, the legacy handshake, and did not retry at ${served}`;
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
      mergeIdentities(identities, seen);
      mergeIdentities(allIdentities, seen);
      const verdict = verdictFor(cell, results?.checks, results?.recorded);
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
        ...(verdict === 'incomplete' &&
          cell.startable && { note: incompleteNote(results?.checks ?? []) }),
        ...(results && { summary: summarize(results.checks) }),
        resultsUrl: sources.resultsUrl(ref),
        ...(seen.length && { identities: seen })
      });
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
