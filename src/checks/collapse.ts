import type { CheckStatus, ConformanceCheck } from '../types';

/**
 * Collapse duplicate non-INFO check IDs to a single entry, preferring the
 * MOST-SEVERE occurrence (FAILURE > WARNING > SUCCESS > any other status, e.g.
 * SKIPPED) so a real failure is never masked. Equal-severity ties keep the LAST
 * occurrence. Per-request INFO log entries are always kept.
 *
 * A check ID is not unique within a run: scenarios re-emit a shared ID when a
 * flow repeats. The RFC 9449 §8/§9 nonce round-trip re-POSTs /token (challenge
 * → retry), so the shared token-flow checks (`token-request`, `pkce-*`) are
 * appended twice; `sep-2575-http-server-meta-invalid-400` is emitted once per
 * iteration of the `_meta` test-case loop. Collapsing reports each ID once
 * without hiding a failure recorded on any occurrence, which is what lets an
 * expected-failures baseline address a check by ID.
 *
 * `keyOf` names what counts as a duplicate (default: the ID). The hosted
 * results page passes ID plus description, so checks that share an ID but
 * check different things (one per method) stay apart.
 */
export function collapseDuplicateChecks<T extends ConformanceCheck>(
  checks: readonly T[],
  keyOf: (c: T) => string = (c) => c.id
): T[] {
  const severity = (s: CheckStatus): number =>
    s === 'FAILURE' ? 3 : s === 'WARNING' ? 2 : s === 'SUCCESS' ? 1 : 0;
  // Winning index per non-INFO key: highest severity, ties → last occurrence.
  const winner = new Map<string, number>();
  checks.forEach((c, i) => {
    if (c.status === 'INFO') return;
    const key = keyOf(c);
    const cur = winner.get(key);
    if (
      cur === undefined ||
      severity(c.status) >= severity(checks[cur].status)
    ) {
      winner.set(key, i);
    }
  });
  return checks.filter(
    (c, i) => c.status === 'INFO' || winner.get(keyOf(c)) === i
  );
}
