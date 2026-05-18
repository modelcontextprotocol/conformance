/**
 * Wire-format validation helpers shared across server-conformance
 * scenarios. Pure predicates / regex — no I/O, no async.
 *
 * Pragmatic choices documented per helper. When validation needs
 * tighten (e.g., the spec mandates a stricter timestamp format), edit
 * here once and every scenario picks it up.
 */

/**
 * ISO-8601 timestamp prefix (YYYY-MM-DDThh:mm:ss). Tolerant about
 * the timezone tail (`Z`, `+00:00`, `+0000`) and sub-second precision —
 * matches what real servers emit (Go `time.RFC3339Nano`,
 * Python `datetime.isoformat()`, JavaScript `toISOString()`).
 *
 * Why a regex over `Date.parse` / `new Date(s).toISOString() === s` /
 * `Temporal.Instant.from`:
 *   - `Date.parse` accepts RFC-2822, "May 4 2026", and other
 *     non-ISO strings — too permissive.
 *   - `new Date(s).toISOString() === s` is too strict — rejects
 *     valid `+00:00`-style offsets that don't survive the canonical
 *     `Z` round-trip.
 *   - `Temporal.Instant.from` is Node 24+ experimental.
 *
 * Swap this constant for a stdlib validator if/when one becomes
 * broadly available.
 */
export const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Returns true when the input is a string matching ISO-8601 prefix. */
export function isIso8601(s: unknown): boolean {
  return typeof s === 'string' && ISO_8601_PATTERN.test(s);
}
