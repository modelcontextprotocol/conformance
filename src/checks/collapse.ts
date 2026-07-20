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
 */
export function collapseDuplicateChecks(
  checks: ConformanceCheck[]
): ConformanceCheck[] {
  const severity = (s: CheckStatus): number =>
    s === 'FAILURE' ? 3 : s === 'WARNING' ? 2 : s === 'SUCCESS' ? 1 : 0;
  // Winning index per non-INFO id: highest severity, ties → last occurrence.
  const winner = new Map<string, number>();
  checks.forEach((c, i) => {
    if (c.status === 'INFO') return;
    const cur = winner.get(c.id);
    if (
      cur === undefined ||
      severity(c.status) >= severity(checks[cur].status)
    ) {
      winner.set(c.id, i);
    }
  });
  return checks.filter((c, i) => c.status === 'INFO' || winner.get(c.id) === i);
}
