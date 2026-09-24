/**
 * One tally for every runner's results line.
 *
 * The `server`, `client` and `authorization-server` runners each counted the
 * same four numbers from the same filters, so a fifth number had to be added in
 * three places or in none.
 *
 * That fifth number is what a reader of a red run most wants: how much of it was
 * a requirement being violated, and how much was a requirement that could not be
 * checked at all. Those are different facts with the same status, because a
 * missing prerequisite reports as a failure on purpose (issue #248) — SKIPPED is
 * excluded from counts, exit codes and the expected-failures baseline, so a
 * skipped row is one nobody can burn down. Splitting them in the output costs
 * nothing and changes no verdict: `unverified` counts rows already inside
 * `failed` and `warnings`, so exit codes stay exactly as they were.
 */

import type { ConformanceCheck } from '../types';
import { notTestable } from '../scenarios/untestable';

/** The prefix `notTestable()` writes, for checks that carry no details flag. */
const NOT_TESTABLE_PREFIX = notTestable('').trim();

export interface CheckTally {
  /** Checks that passed. */
  passed: number;
  /** Checks with status FAILURE, including ones that could not be exercised. */
  failed: number;
  /** Checks with status WARNING, including ones that could not be exercised. */
  warnings: number;
  /** SUCCESS + FAILURE, the population the pass ratio is quoted against. */
  denominator: number;
  /**
   * Of `failed` + `warnings`, how many report a missing prerequisite rather
   * than a violated requirement. A subset, never an addition.
   */
  unverified: number;
}

/**
 * Whether a check reports a prerequisite it could not satisfy.
 *
 * Either signal counts: `untestableCheck()` sets `details.untestable`, and a
 * scenario that formats its own message with `notTestable()` carries only the
 * prefix. Reading both means a scenario cannot fall out of the tally by
 * building its check the other way.
 */
export function isUnverified(check: ConformanceCheck): boolean {
  if (check.status !== 'FAILURE' && check.status !== 'WARNING') return false;
  if (check.details?.untestable === true) return true;
  return (check.errorMessage ?? '').startsWith(NOT_TESTABLE_PREFIX);
}

export function tallyChecks(checks: ConformanceCheck[]): CheckTally {
  return {
    passed: checks.filter((c) => c.status === 'SUCCESS').length,
    failed: checks.filter((c) => c.status === 'FAILURE').length,
    warnings: checks.filter((c) => c.status === 'WARNING').length,
    denominator: checks.filter(
      (c) => c.status === 'SUCCESS' || c.status === 'FAILURE'
    ).length,
    unverified: checks.filter(isUnverified).length
  };
}

/**
 * The results line. The unverified clause is appended only when there is one,
 * so a run with nothing unverified prints exactly what it always printed.
 */
export function formatTally(tally: CheckTally): string {
  const base = `Passed: ${tally.passed}/${tally.denominator}, ${tally.failed} failed, ${tally.warnings} warnings`;
  return tally.unverified > 0
    ? `${base} (${tally.unverified} of those unverified, not violated)`
    : base;
}
