/**
 * A cell's checks as its results page, its JSON and the run report show
 * them. Nothing here changes a check's status or the cell's verdict (see
 * ./report.ts verdictFor(), which reads the judged checks themselves); it
 * only decides how many rows the checks make and what each row says.
 *
 * One row per check: a check recorded again with the same id and
 * description — the protected-resource metadata fetched on every retry, a
 * token request repeated after a nonce challenge — is one row with
 * `repeats`, chosen by the rule the expected-failures baseline uses (the
 * most severe, ties to the latest; see ../checks/collapse.ts). Checks that
 * share an id but check different things (a description or a
 * `details.method` per method) stay apart.
 * INFO rows (request logs, the client's identity) are kept as they are.
 */

import type { ConformanceCheck } from '../types';
import { collapseDuplicateChecks } from '../checks/collapse';

export interface ShownCheck extends ConformanceCheck {
  /** How many times the check was recorded, when more than once. */
  repeats?: number;
}

/** Same check: same id, same description, judged on the same method. */
const rowKey = (c: ConformanceCheck) => {
  const method = c.details?.method;
  return `${c.id}\n${c.description}\n${typeof method === 'string' ? method : ''}`;
};

export function shownChecks(checks: readonly ConformanceCheck[]): ShownCheck[] {
  const times = new Map<string, number>();
  for (const c of checks) {
    if (c.status === 'INFO') continue;
    times.set(rowKey(c), (times.get(rowKey(c)) ?? 0) + 1);
  }
  return collapseDuplicateChecks(checks, rowKey).map((c) => {
    const n = c.status === 'INFO' ? 1 : (times.get(rowKey(c)) ?? 1);
    return n > 1 ? { ...c, repeats: n } : c;
  });
}
