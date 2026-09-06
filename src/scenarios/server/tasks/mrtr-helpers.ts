/**
 * Generic conformance-check helpers shared by the SEP-2663 `tasks/*`
 * scenarios. Pure: no I/O, no scenario-specific state.
 *
 * Split from `helpers.ts` (which holds tasks-specific helpers like
 * `validTasksParams` and the polling loops) so that the SEP references
 * and the FAILURE/SKIPPED check builders can be reused by any future
 * extension scenario without dragging tasks-domain types along.
 */

import type { ConformanceCheck, SpecReference } from '../../../types';
import { MRTR_SPEC_REFERENCES } from '../input-required-result-helpers';

// ────────────────────────────────────────────────────────────────────────
// Check builders
// ────────────────────────────────────────────────────────────────────────

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a FAILURE check from a thrown error, preserving id/name/description. */
export function failureCheck(
  id: string,
  name: string,
  description: string,
  error: unknown,
  specReferences: SpecReference[]
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: errMsg(error),
    specReferences
  };
}

/**
 * Build a SKIPPED check (preserves id stability so Ctrl+F still finds it).
 *
 * Use ONLY for checks that are legitimately not applicable (e.g. a harness
 * gap the suite itself tracks). A check whose prerequisite is missing on the
 * server under test must use untestableCheck from src/scenarios/untestable.ts
 * instead — SKIPPED reads as green in every consumer (issue #248).
 */
export function skipCheck(
  id: string,
  name: string,
  description: string,
  reason: string,
  specReferences: SpecReference[]
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage: `Skipped: ${reason}`,
    specReferences
  };
}

// ────────────────────────────────────────────────────────────────────────
// SEP references
// ────────────────────────────────────────────────────────────────────────

export const SEP_2243_REF: SpecReference = {
  id: 'SEP-2243',
  url: 'https://modelcontextprotocol.io/seps/2243-http-standardization'
};

/**
 * SEP-2322 (MRTR). Imported from `input-required-result-helpers` so the
 * codebase holds a single URL per SEP — the rendered spec page absorbs
 * post-merge amendments and `MRTR_SPEC_REFERENCES` is already the
 * traceability anchor for SEP-2322 elsewhere in `server/`.
 */
export const SEP_2322_REF: SpecReference = MRTR_SPEC_REFERENCES[0];

export const SEP_2575_REF: SpecReference = {
  id: 'SEP-2575',
  url: 'https://modelcontextprotocol.io/seps/2575-stateless-mcp'
};

export const SEP_2663_REF: SpecReference = {
  id: 'SEP-2663',
  url: 'https://modelcontextprotocol.io/seps/2663-tasks-extension'
};

// ────────────────────────────────────────────────────────────────────────
// Wire-format predicates
// ────────────────────────────────────────────────────────────────────────

/**
 * ISO-8601 timestamp prefix (YYYY-MM-DDThh:mm:ss). Tolerant about the
 * timezone tail (`Z`, `+00:00`, `+0000`) and sub-second precision —
 * matches what real servers emit (Go `time.RFC3339Nano`, Python
 * `datetime.isoformat()`, JavaScript `toISOString()`).
 *
 * A regex over `Date.parse` (too permissive, accepts RFC-2822, "May 4
 * 2026") / `new Date(s).toISOString() === s` (too strict, rejects
 * valid `+00:00` offsets that don't survive the canonical `Z`
 * round-trip) / `Temporal.Instant.from` (Node 24+ experimental).
 */
export const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Returns true when the input is a string matching ISO-8601 prefix. */
export function isIso8601(s: unknown): boolean {
  return typeof s === 'string' && ISO_8601_PATTERN.test(s);
}
