/**
 * Helpers shared by the SEP-2663 tasks and SEP-2322 MRTR scenarios.
 *
 * Bundled in one file (matching the `input-required-result-helpers.ts`
 * precedent) rather than spread across a category-specific subdirectory.
 * Pure: no I/O, no scenario-specific state.
 */

import { z } from 'zod';

import type { ConformanceCheck, SpecReference } from '../../types';

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

/** Build a SKIPPED check (preserves id stability so Ctrl+F still finds it). */
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

/**
 * Zod passthrough schema. Pair with `client.request(req, AnyResult)` to
 * preserve fields the SDK's typed result schemas would strip. Every
 * SEP-2663 / SEP-2322 wire field falls into this bucket today.
 */
export const AnyResult = z.object({}).passthrough();

// ────────────────────────────────────────────────────────────────────────
// SEP references
// ────────────────────────────────────────────────────────────────────────

export const SEP_2243_REF: SpecReference = {
  id: 'SEP-2243',
  url: 'https://modelcontextprotocol.io/seps/2243-http-standardization'
};

export const SEP_2322_REF: SpecReference = {
  id: 'SEP-2322',
  url: 'https://modelcontextprotocol.io/seps/2322-MRTR'
};

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
 * A regex over `Date.parse` (too permissive — accepts RFC-2822, "May 4
 * 2026") / `new Date(s).toISOString() === s` (too strict — rejects
 * valid `+00:00` offsets that don't survive the canonical `Z`
 * round-trip) / `Temporal.Instant.from` (Node 24+ experimental).
 */
export const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Returns true when the input is a string matching ISO-8601 prefix. */
export function isIso8601(s: unknown): boolean {
  return typeof s === 'string' && ISO_8601_PATTERN.test(s);
}
