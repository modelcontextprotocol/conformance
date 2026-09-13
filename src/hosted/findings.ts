/**
 * What went wrong in a run, in a form a person can read at a glance and
 * paste somewhere: every cell's failures and warnings as one line each,
 * whose they are, and the same cause said once across the cells it covers.
 *
 *   by: 'client'    seen in the client's traffic;
 *   by: 'scenario'  the scenario's own expectation that nothing has met yet
 *                   ("Tool was not called by client") — what the scenario
 *                   reports when it has seen nothing at all.
 *
 * A client that only speaks an older revision opens every 2026-07-28 cell
 * with `initialize`, is answered -32022 and never retries: that is one
 * cause, however many cells it stopped. Nothing here changes a check or a
 * verdict; it only reads them.
 */

import type { ConformanceCheck, SpecVersion } from '../types';
import { finalizeChecks } from './session';
import { IDENTITY_CHECK_ID } from './identity';
import {
  GET_ON_MCP_CHECK_ID,
  LEGACY_PROBE_CHECK_ID,
  WIRE_REJECTED_CHECK_ID,
  WRONG_REVISION_CHECK_ID
} from './wire';

export interface Finding {
  status: 'FAILURE' | 'WARNING';
  /** The check's id. */
  check: string;
  /** What went wrong, in one line (see oneLineReason()). */
  reason: string;
  by: 'client' | 'scenario';
  /** Key of the RunReport cause it is grouped under, when it is grouped. */
  cause?: string;
}

export interface Cause {
  key: string;
  by: 'client' | 'scenario';
  /** The check's id, when the cause is one check's finding. */
  check?: string;
  /** What went wrong, once. */
  text: string;
  /** The cells it covers, `<revision>/<scenario>`. */
  cells: string[];
}

/** A client that opened with `initialize` on the stateless wire and stopped. */
export interface LegacyStop {
  /** The revision it asked for, when it said. */
  asked?: string;
  served: string;
  /** The JSON-RPC code the cell answered with, when it turned it away. */
  code?: number;
  /** It then sent GET to the MCP endpoint: the old HTTP+SSE fallback. */
  fellBack: boolean;
}

const REASON_MAX = 240;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Whitespace folded to single spaces, cut to `max` characters. */
export function oneLine(text: string, max = REASON_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * What went wrong, in one line: the check's errorMessage, else the
 * `details.message` many scenarios use, else its description (auth checks
 * put their finding there: "Client used client_secret_post but server only
 * supports client_secret_basic"). An `expectedX`/`actualX` pair in details
 * the text does not already quote is added, and so is a `stopReason`.
 */
export function oneLineReason(c: ConformanceCheck): string {
  const details = (c.details ?? {}) as Record<string, unknown>;
  let text = c.errorMessage || str(details.message) || c.description || c.name;
  for (const key of Object.keys(details)) {
    if (!key.startsWith('expected')) continue;
    const expected = details[key];
    const actual = details[`actual${key.slice('expected'.length)}`];
    if (!['string', 'number'].includes(typeof expected)) continue;
    if (!['string', 'number'].includes(typeof actual)) continue;
    if (!text.includes(String(actual))) {
      text += ` (expected ${expected}, got ${actual})`;
    }
    break;
  }
  const stop = str(details.stopReason);
  if (stop) text += ` (${stop})`;
  return oneLine(text);
}

/**
 * Whether the cell saw the client only as a legacy `initialize` on the
 * stateless wire: the probe is there, and the client never spoke the cell's
 * revision afterwards (see report.ts incompleteNote()).
 */
export function legacyStop(
  checks: readonly ConformanceCheck[]
): LegacyStop | undefined {
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
  const rejected = probe.details?.rejected as { code?: unknown } | undefined;
  return {
    ...(str(probe.details?.requestedVersion) && {
      asked: probe.details!.requestedVersion as string
    }),
    served,
    ...(typeof rejected?.code === 'number' && { code: rejected.code }),
    fellBack: checks.some((c) => c.id === GET_ON_MCP_CHECK_ID)
  };
}

/**
 * Checks that only say the client spoke the wrong era: on a cell the client
 * reached with a legacy `initialize` alone, they are that one cause, not a
 * finding of their own. `stateless-request-rejected` is the auth scenarios'
 * resource server answering the same -32022 after sign-in.
 */
const ERA_CHECKS = new Set([
  WRONG_REVISION_CHECK_ID,
  WIRE_REJECTED_CHECK_ID,
  'stateless-request-rejected'
]);

const findingKey = (c: Pick<Finding, 'status' | 'check' | 'reason'>) =>
  `${c.status} ${c.check} ${c.reason}`;

/**
 * Per (scenario, revision): the findings the scenario reports when it has
 * seen nothing at all. A finding on a real log that is one of these is the
 * scenario still waiting, not something the client did.
 */
const expectedCache = new Map<string, Set<string>>();

function expectedKeys(scenario: string, revision: SpecVersion): Set<string> {
  const cacheKey = `${scenario}@${revision}`;
  let keys = expectedCache.get(cacheKey);
  if (!keys) {
    keys = new Set(
      finalizeChecks(scenario, [], revision)
        .filter((c) => c.status === 'FAILURE' || c.status === 'WARNING')
        .map((c) =>
          findingKey({
            status: c.status as Finding['status'],
            check: c.id,
            reason: oneLineReason(c)
          })
        )
    );
    expectedCache.set(cacheKey, keys);
  }
  return keys;
}

export const legacyCauseKey = (stop: LegacyStop) =>
  `legacy ${stop.asked ?? ''} ${stop.served}`;

/**
 * A cell's failures and warnings, one per distinct (check, reason), each
 * marked client or scenario. With `stop`, the ones the legacy handshake
 * explains are keyed to that cause; `grouped` false leaves every finding
 * ungrouped (a cell still in progress: its findings are only what it waits
 * for).
 */
export function findingsOf(
  scenario: string,
  revision: SpecVersion,
  checks: readonly ConformanceCheck[],
  stop: LegacyStop | undefined,
  grouped: boolean
): Finding[] {
  const expected = expectedKeys(scenario, revision);
  const out = new Map<string, Finding>();
  for (const c of checks) {
    if (c.status !== 'FAILURE' && c.status !== 'WARNING') continue;
    const finding: Finding = {
      status: c.status,
      check: c.id,
      reason: oneLineReason(c),
      by: 'client'
    };
    const key = findingKey(finding);
    if (out.has(key)) continue;
    if (expected.has(key)) finding.by = 'scenario';
    if (grouped) {
      finding.cause =
        stop && (finding.by === 'scenario' || ERA_CHECKS.has(c.id))
          ? legacyCauseKey(stop)
          : `check ${key}`;
    }
    out.set(key, finding);
  }
  return Array.from(out.values());
}

/** The sentence for a legacy-handshake cause over `stops` (one per cell). */
export function legacyCauseText(stops: readonly LegacyStop[]): string {
  const { asked, served, code } = stops[0];
  const spoke = asked
    ? `The client spoke ${asked} only`
    : 'The client spoke only the legacy handshake';
  const answer =
    code !== undefined
      ? `the cell answered ${code} (supported: ${served})`
      : 'the cell accepted it';
  let text = `${spoke}: it opened with initialize, ${answer}, and the client did not retry at ${served}.`;
  const fellBack = stops.filter((s) => s.fellBack).length;
  if (fellBack) {
    text +=
      fellBack === stops.length
        ? ' It then sent GET, falling back to the old HTTP+SSE transport.'
        : ` On ${fellBack} of these cells it then sent GET, falling back to the old HTTP+SSE transport.`;
  }
  return text;
}

export interface CellFindings {
  /** `<revision>/<scenario>`. */
  cell: string;
  findings: readonly Finding[];
  /** The legacy stop, when the cell's cause key names it. */
  stop?: LegacyStop;
  /** The cell was stopped by `stop` even if it lists no finding. */
  stoppedBy?: string;
}

/**
 * Every grouped finding across the run, said once per cause: client causes
 * first, then those covering the most cells.
 */
export function groupCauses(cells: readonly CellFindings[]): Cause[] {
  const causes = new Map<string, Cause & { stops: LegacyStop[] }>();
  const add = (
    key: string,
    cell: string,
    make: () => Omit<Cause, 'cells'>,
    stop?: LegacyStop
  ) => {
    let cause = causes.get(key);
    if (!cause) causes.set(key, (cause = { ...make(), cells: [], stops: [] }));
    if (!cause.cells.includes(cell)) {
      cause.cells.push(cell);
      if (stop) cause.stops.push(stop);
    }
  };
  for (const c of cells) {
    if (c.stoppedBy && c.stop) {
      add(
        c.stoppedBy,
        c.cell,
        () => ({ key: c.stoppedBy!, by: 'client', text: '' }),
        c.stop
      );
    }
    for (const f of c.findings) {
      if (!f.cause) continue;
      if (c.stop && f.cause === legacyCauseKey(c.stop)) {
        add(
          f.cause,
          c.cell,
          () => ({ key: f.cause!, by: 'client', text: '' }),
          c.stop
        );
        continue;
      }
      add(f.cause, c.cell, () => ({
        key: f.cause!,
        by: f.by,
        check: f.check,
        text: f.reason
      }));
    }
  }
  return Array.from(causes.values())
    .map(({ stops, ...cause }) =>
      stops.length ? { ...cause, text: legacyCauseText(stops) } : cause
    )
    .sort(
      (a, b) =>
        Number(a.by === 'scenario') - Number(b.by === 'scenario') ||
        b.cells.length - a.cells.length
    );
}
