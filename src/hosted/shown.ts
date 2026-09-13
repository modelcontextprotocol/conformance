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
 *
 * Each FAILURE and WARNING row says in `reason` what went wrong, in one
 * line, and one the scenario reports before it has seen anything — a step
 * the flow never reached — is marked `notSeen` (see ./findings.ts
 * notSeenIn()). Each SKIPPED row says why it was skipped. A row never
 * carries `details: null`.
 */

import type { ConformanceCheck, SpecVersion } from '../types';
import { collapseDuplicateChecks } from '../checks/collapse';
import { notSeenIn, notSeenReason, oneLine, oneLineReason } from './findings';

export interface ShownCheck extends ConformanceCheck {
  /** How many times the check was recorded, when more than once. */
  repeats?: number;
  /**
   * The scenario's own expectation that nothing has met yet, not something
   * seen in the client's traffic: the flow may not have got that far.
   */
  notSeen?: true;
  /**
   * On a FAILURE or WARNING row: what went wrong, in one line. On a SKIPPED
   * row: why nothing was checked.
   */
  reason?: string;
}

/** Why a SKIPPED check was skipped, when it does not say. */
export const SKIPPED_REASON =
  'skipped: the client did nothing this check covers';

/** Same check: same id, same description, judged on the same method. */
const rowKey = (c: ConformanceCheck) => {
  const method = c.details?.method;
  return `${c.id}\n${c.description}\n${typeof method === 'string' ? method : ''}`;
};

export function shownChecks(
  scenario: string,
  revision: SpecVersion,
  checks: readonly ConformanceCheck[]
): ShownCheck[] {
  const notSeen = notSeenIn(scenario, revision, checks);
  // The same record twice (the same timestamp and all) is one record that
  // two processes both persisted, not the client doing it again.
  const records = new Set<string>();
  const unique = checks.filter((c) => {
    const record = JSON.stringify(c);
    if (records.has(record)) return false;
    records.add(record);
    return true;
  });
  const times = new Map<string, number>();
  for (const c of unique) {
    if (c.status === 'INFO') continue;
    times.set(rowKey(c), (times.get(rowKey(c)) ?? 0) + 1);
  }
  return collapseDuplicateChecks(unique, rowKey).map((c) => {
    const { details, ...row }: ShownCheck = c;
    const shown: ShownCheck = details == null ? row : { ...row, details };
    const n = c.status === 'INFO' ? 1 : (times.get(rowKey(c)) ?? 1);
    if (n > 1) shown.repeats = n;
    if (c.status === 'FAILURE' || c.status === 'WARNING') {
      const unmet = notSeen(c);
      if (unmet) shown.notSeen = true;
      shown.reason = unmet ? notSeenReason(c) : oneLineReason(c);
    } else if (c.status === 'SKIPPED') {
      const message = c.errorMessage || c.details?.message;
      shown.reason =
        typeof message === 'string' && message
          ? oneLine(message)
          : SKIPPED_REASON;
    }
    return shown;
  });
}
