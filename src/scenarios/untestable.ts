/**
 * "Untestable" check policy (issue #248).
 *
 * A check whose prerequisite is missing — the server under test lacks a
 * diagnostic fixture tool, rejects the probe that would exercise the
 * requirement, or advertises a feature it does not actually serve — MUST NOT
 * report SKIPPED: SKIPPED is excluded from pass/fail counts, exit codes, and
 * the expected-failures baseline, so the run reads as green and the gap is
 * invisible to anyone burning down a conformance list. Instead the check
 * fails, with an errorMessage that names the missing prerequisite, so the
 * result is red until the prerequisite exists and the scenario can sit in an
 * expected-failures baseline meanwhile (the documented escape hatch).
 *
 * SKIPPED remains correct only for checks that are legitimately not
 * applicable: an optional capability the server never claimed (e.g. a SHOULD
 * check gated on `prompts.listChanged` the server did not declare), or
 * spec-version inapplicability handled by the runner.
 */

import type { ConformanceCheck, SpecReference } from '../types';

/**
 * Format the errorMessage for a check that could not be exercised. The
 * stable prefix lets reports and dashboards distinguish "requirement was
 * violated" from "requirement could not be verified" without a new status.
 */
export function notTestable(reason: string): string {
  return `Not testable: ${reason}`;
}

/**
 * Build a failing check for a requirement that could not be exercised
 * because a prerequisite is missing. `severity` follows the spec keyword of
 * the underlying requirement (MUST -> FAILURE, SHOULD -> WARNING), matching
 * what the check could have reported had it run.
 */
export function untestableCheck(
  id: string,
  name: string,
  description: string,
  reason: string,
  specReferences: SpecReference[],
  severity: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: severity,
    timestamp: new Date().toISOString(),
    errorMessage: notTestable(reason),
    specReferences,
    details: { untestable: true, reason }
  };
}
