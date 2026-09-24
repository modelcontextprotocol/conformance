/**
 * MCP Events — poll delivery, the `EventOccurrence` shape, and cursor
 * lifecycle.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec excerpt lives next to its check ID in
 * src/seps/sep-9999.yaml. 9999 is a placeholder SEP number; see that file's
 * header.
 *
 * Poll is the mode a conformance harness can exercise completely. It is
 * request/response, it holds no server-side state, and every poll response
 * carries the cursor, so cursor advancement and `truncated` are observable
 * without waiting for anything to happen upstream. Push needs a live stream
 * and webhook needs a reachable callback; both are separate scenarios.
 *
 * The scenario drives a real quiet-period poll loop: two polls with the cursor
 * from the first fed into the second. That is what makes
 * `sep-9999-cursor-advances-when-quiet` gradeable against a server with no
 * traffic, which is the state a conformance fixture is usually in.
 *
 * Nothing is hardcoded to a fixture's event names. The scenario picks the
 * first descriptor advertising `poll` and works from there; when none does,
 * every check reports the unmet prerequisite rather than passing vacuously.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  EVENTS_EXTENSION_ID,
  EVENTS_POLL_METHOD,
  EVENTS_SPEC_REF,
  EVENTS_NOT_FOUND,
  EVENTS_UNSUPPORTED,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  type EventDescriptor,
  type EventOccurrence,
  type EventsPollResult,
  declaredEventsCapability,
  eventsCheck,
  eventsListAll,
  eventsPoll,
  occurrences,
  deliveryModes,
  descriptorName,
  describeValue,
  isObject,
  isValidCursor,
  isIso8601,
  minimalArguments,
  firstSupporting,
  unknownEventName
} from './helpers';

const POLL_IDS = [
  'sep-9999-poll-implemented',
  'sep-9999-poll-one-subscription-per-request',
  'sep-9999-poll-bootstraps-subscription',
  'sep-9999-poll-events-array',
  'sep-9999-poll-response-cursor',
  'sep-9999-poll-next-poll-ms',
  'sep-9999-poll-next-poll-ms-ignored-when-has-more',
  'sep-9999-poll-has-more',
  'sep-9999-poll-max-events-cap',
  'sep-9999-poll-stateless-request',
  'sep-9999-poll-errors-are-jsonrpc',
  'sep-9999-poll-invalid-arguments',
  'sep-9999-poll-mode-unsupported',
  'sep-9999-removal-poll-not-found'
] as const;

/** How long to follow the bootstrap cursor waiting for a delivered event. */
const OCCURRENCE_WAIT_MS = 6000;

const OCCURRENCE_IDS = [
  'sep-9999-occurrence-event-id',
  'sep-9999-occurrence-name',
  'sep-9999-occurrence-timestamp',
  'sep-9999-occurrence-data',
  'sep-9999-occurrence-cursor-optional',
  'sep-9999-occurrence-meta-ungoverned',
  'sep-9999-occurrence-event-id-from-upstream'
] as const;

const CURSOR_IDS = [
  'sep-9999-cursor-opaque',
  'sep-9999-cursor-null-starts-from-now',
  'sep-9999-cursor-absent-equals-null',
  'sep-9999-cursor-consistency',
  'sep-9999-cursor-advances-when-quiet',
  'sep-9999-max-age-ms-floor',
  'sep-9999-max-age-ms-sets-truncated',
  'sep-9999-max-age-ms-ignored-when-cursor-null',
  'sep-9999-replay-ceiling-sets-truncated',
  'sep-9999-truncated-returns-fresh-cursor',
  'sep-9999-truncated-poll-never-an-error',
  'sep-9999-truncated-false-when-no-replay'
] as const;

/**
 * Pair the `-32602` rule row with the error-table row for the same code.
 *
 * One probe, two rows: the first says arguments that violate `inputSchema` are
 * rejected, the second says the code for a statically invalid request is
 * `-32602`. A server gets the same verdict on both because there is nothing to
 * tell apart, and `details.gradedBy` says where it came from.
 */
function withErrorCodeRow(ruleCheck: ConformanceCheck): ConformanceCheck[] {
  return [
    ruleCheck,
    eventsCheck(
      'sep-9999-error-invalid-params',
      "`-32602 InvalidParams` — request is statically invalid: arguments don't match the event's inputSchema, the callback `delivery.url` is malformed or non-`https`, or `delivery.secret` is not a valid `whsec_` value.",
      ruleCheck.status,
      {
        errorMessage: ruleCheck.errorMessage,
        details: {
          gradedBy: 'sep-9999-poll-invalid-arguments',
          untestable: ruleCheck.details?.untestable
        }
      }
    )
  ];
}

/**
 * The error-table row this scenario claims. `-32602` has three provoking cases
 * in the document and the suite already fires one of them here, so the row is
 * graded off that probe rather than a fourth request, the way
 * sep-9999-subscribe-url-https-required rides its enforcement probe in
 * events-webhook.
 */
const ERROR_IDS = ['sep-9999-error-invalid-params'] as const;

const ALL_IDS = [...POLL_IDS, ...OCCURRENCE_IDS, ...CURSOR_IDS, ...ERROR_IDS];

/** Milliseconds of replay to request when probing the `maxAgeMs` floor. */
const MAX_AGE_PROBE_MS = 300_000;

function skipAll(reason: string): ConformanceCheck[] {
  return ALL_IDS.map((id) =>
    eventsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
  );
}

function untestableAll(
  ids: readonly string[],
  reason: string,
  severity: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck[] {
  return ids.map((id) =>
    untestableCheck(id, id, id, reason, [EVENTS_SPEC_REF], severity)
  );
}

export class EventsPollScenario implements ClientScenario {
  name = 'events-poll';
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;
  description = `MCP Events: \`events/poll\` delivery, the \`EventOccurrence\` shape, and cursor lifecycle.

**Methods**: \`events/poll\`, plus \`events/list\` to discover a poll-capable event type

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-9999.yaml):

- \`sep-9999-poll-implemented\` / \`sep-9999-poll-bootstraps-subscription\` — a poll with \`cursor: null\` succeeds with no prior subscribe step
- \`sep-9999-poll-events-array\` / \`sep-9999-poll-response-cursor\` / \`sep-9999-poll-next-poll-ms\` / \`sep-9999-poll-has-more\` — the four response fields
- \`sep-9999-poll-max-events-cap\` — \`maxEvents\` caps the batch and sets \`hasMore\` when more remain
- \`sep-9999-poll-stateless-request\` — two identical polls are answerable without server-side memory of the first
- \`sep-9999-poll-errors-are-jsonrpc\` / \`sep-9999-removal-poll-not-found\` / \`sep-9999-poll-invalid-arguments\` / \`sep-9999-poll-mode-unsupported\` — the error contract
- \`sep-9999-occurrence-*\` — \`eventId\`, \`name\`, \`timestamp\`, \`data\` required; \`cursor\` and \`_meta\` optional
- \`sep-9999-cursor-*\` — opaqueness, \`null\` means start-from-now, absent means \`null\`, consistency, and advancement during quiet periods
- \`sep-9999-max-age-ms-*\` / \`sep-9999-truncated-*\` — bounding replay and signalling a gap

**Discovery is dynamic**: a server that neither declares the capability nor implements \`events/list\` SKIPs everything; no poll-capable event type reports the poll checks as untestable. Checks that need a delivered event (the \`EventOccurrence\` shape) are untestable against a quiet server rather than passing vacuously.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      return await this.checks(conn);
    } finally {
      await conn.close();
    }
  }

  private async checks(conn: Connection): Promise<ConformanceCheck[]> {
    const { declared } = await declaredEventsCapability(conn);
    const listed = await eventsListAll(conn);

    if ('error' in listed) {
      // Undeclared and unimplemented is the one case that legitimately skips:
      // the server simply does not do events. Every other shape is graded,
      // including the undeclared-but-serving case events-discovery fails on.
      if (!declared && listed.error.code === JSONRPC_METHOD_NOT_FOUND) {
        return skipAll(
          'Server does not declare the `events` capability and does not implement `events/list`; the extension is optional.'
        );
      }
      return untestableAll(
        ALL_IDS,
        `\`events/list\` failed (${listed.error.code} ${listed.error.message}), so no poll-capable event type could be discovered. See the events-discovery scenario.`
      );
    }

    const descriptors = listed.descriptors;
    const target = firstSupporting(descriptors, 'poll');
    const name = target ? descriptorName(target) : undefined;

    if (!target || !name) {
      return untestableAll(
        ALL_IDS,
        descriptors.length === 0
          ? '`events/list` returned an empty catalog, so no poll-capable event type could be exercised.'
          : 'No event type advertises `poll` delivery, so `events/poll` could not be exercised. Poll is optional per event type.'
      );
    }

    const args = minimalArguments(target);
    if (args === undefined) {
      return untestableAll(
        ALL_IDS,
        `Event type \`${name}\` declares required \`inputSchema\` properties, so the harness cannot construct arguments it is confident the server will accept.`
      );
    }

    const checks: ConformanceCheck[] = [];

    // --- The bootstrap poll ----------------------------------------------
    const first = await eventsPoll(conn, {
      name,
      arguments: args,
      cursor: null
    });
    if ('error' in first) {
      const err = first.error;
      checks.push(
        eventsCheck(
          'sep-9999-poll-implemented',
          '`events/poll` is request/response: client sends `{name, arguments, cursor}`, gets back `{events[], cursor, nextPollMs}`.',
          'FAILURE',
          {
            errorMessage: `Event type \`${name}\` advertises \`poll\` delivery but \`${EVENTS_POLL_METHOD}\` failed: ${err.code} ${err.message}`,
            details: { code: err.code, message: err.message, data: err.data }
          }
        )
      );
      checks.push(
        ...untestableAll(
          ALL_IDS.filter((id) => id !== 'sep-9999-poll-implemented'),
          `The bootstrap \`${EVENTS_POLL_METHOD}\` for \`${name}\` failed with ${err.code} ${err.message}.`
        )
      );
      return checks;
    }

    const r1 = first.result;
    checks.push(
      eventsCheck(
        'sep-9999-poll-implemented',
        '`events/poll` is request/response: client sends `{name, arguments, cursor}`, gets back `{events[], cursor, nextPollMs}`.',
        'SUCCESS'
      )
    );
    checks.push(
      eventsCheck(
        'sep-9999-poll-bootstraps-subscription',
        'No separate subscribe step needed — the first poll with a null cursor bootstraps the subscription.',
        'SUCCESS',
        { details: { name } }
      )
    );

    checks.push(...this.responseShapeChecks(r1));
    checks.push(...this.cursorNullChecks(r1));

    // --- Quiet-period advancement ----------------------------------------
    checks.push(...(await this.quietAdvanceChecks(conn, name, args, r1)));

    // --- maxEvents / hasMore ---------------------------------------------
    checks.push(...(await this.maxEventsChecks(conn, name, args)));

    // --- maxAgeMs and truncated ------------------------------------------
    checks.push(...(await this.replayChecks(conn, name, args, r1)));

    // --- EventOccurrence shape -------------------------------------------
    // Not graded off r1: `cursor: null` starts from now, so a conformant
    // bootstrap poll is empty. Follow its cursor until something is delivered.
    const delivered = await this.pollForOccurrences(conn, name, args, r1);
    checks.push(...this.occurrenceChecks(delivered, target));

    // --- Error contract ---------------------------------------------------
    checks.push(...(await this.errorChecks(conn, descriptors, name, args)));

    return checks;
  }

  /** The four response fields, graded off the bootstrap poll. */
  private responseShapeChecks(r: EventsPollResult): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];

    out.push(
      Array.isArray(r.events)
        ? eventsCheck(
            'sep-9999-poll-events-array',
            'The poll response carries an `events` array. An empty array means nothing happened.',
            'SUCCESS',
            { details: { count: occurrences(r).length } }
          )
        : eventsCheck(
            'sep-9999-poll-events-array',
            'The poll response carries an `events` array. An empty array means nothing happened.',
            'FAILURE',
            {
              errorMessage: `\`events\` is ${describeValue(r.events)}, expected an array (empty when nothing happened).`,
              details: { events: r.events }
            }
          )
    );

    out.push(
      isValidCursor(r.cursor)
        ? eventsCheck(
            'sep-9999-poll-response-cursor',
            'The poll response carries `cursor` at the response level, the subscription position after this batch.',
            'SUCCESS',
            { details: { cursor: r.cursor ?? null } }
          )
        : eventsCheck(
            'sep-9999-poll-response-cursor',
            'The poll response carries `cursor` at the response level, the subscription position after this batch.',
            'FAILURE',
            {
              errorMessage: `\`cursor\` is ${describeValue(r.cursor)}, expected a string, null, or absent.`,
              details: { cursor: r.cursor }
            }
          )
    );

    // nextPollMs is the field the 197c32b4 rename introduced. A server still
    // emitting nextPollSeconds is the single most likely failure here, so name
    // it rather than reporting a generic absence.
    const legacy = 'nextPollSeconds' in r;
    if (typeof r.nextPollMs === 'number' && Number.isFinite(r.nextPollMs)) {
      out.push(
        eventsCheck(
          'sep-9999-poll-next-poll-ms',
          '`nextPollMs` allows the server to dynamically adjust polling frequency.',
          'SUCCESS',
          { details: { nextPollMs: r.nextPollMs } }
        )
      );
    } else {
      out.push(
        eventsCheck(
          'sep-9999-poll-next-poll-ms',
          '`nextPollMs` allows the server to dynamically adjust polling frequency.',
          'WARNING',
          {
            errorMessage: legacy
              ? 'Response carries `nextPollSeconds`, the pre-rename field name. Spec commit `197c32b4` (2026-05-10) renamed the duration fields to `nextPollMs`.'
              : `\`nextPollMs\` is ${describeValue(r.nextPollMs)}, expected a number of milliseconds.`,
            details: {
              nextPollMs: r.nextPollMs,
              nextPollSeconds: r.nextPollSeconds
            }
          }
        )
      );
    }

    out.push(
      r.hasMore === undefined || typeof r.hasMore === 'boolean'
        ? eventsCheck(
            'sep-9999-poll-has-more',
            '`hasMore` indicates whether additional events are available beyond the returned batch.',
            'SUCCESS',
            { details: { hasMore: r.hasMore ?? false } }
          )
        : eventsCheck(
            'sep-9999-poll-has-more',
            '`hasMore` indicates whether additional events are available beyond the returned batch.',
            'FAILURE',
            {
              errorMessage: `\`hasMore\` is ${describeValue(r.hasMore)}, expected a boolean.`,
              details: { hasMore: r.hasMore }
            }
          )
    );

    // `nextPollMs` is ignored when `hasMore` is true, which is only observable
    // on a response that actually sets it.
    out.push(
      r.hasMore === true
        ? eventsCheck(
            'sep-9999-poll-next-poll-ms-ignored-when-has-more',
            '`nextPollMs` is ignored when `hasMore` is `true`.',
            'SUCCESS',
            { details: { hasMore: true, nextPollMs: r.nextPollMs } }
          )
        : untestableCheck(
            'sep-9999-poll-next-poll-ms-ignored-when-has-more',
            'sep-9999-poll-next-poll-ms-ignored-when-has-more',
            '`nextPollMs` is ignored when `hasMore` is `true`.',
            'Server has no backlog, so no response set `hasMore: true` and the interaction between the two fields could not be observed.',
            [EVENTS_SPEC_REF],
            'WARNING'
          )
    );

    return out;
  }

  /** What a `cursor: null` bootstrap poll establishes on its own. */
  private cursorNullChecks(r: EventsPollResult): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const events = occurrences(r);

    out.push(
      events.length === 0
        ? eventsCheck(
            'sep-9999-cursor-null-starts-from-now',
            'Passing `cursor: null` means "start from now." No historical events are replayed.',
            'SUCCESS',
            { details: { returned: 0 } }
          )
        : eventsCheck(
            'sep-9999-cursor-null-starts-from-now',
            'Passing `cursor: null` means "start from now." No historical events are replayed.',
            'FAILURE',
            {
              errorMessage: `A poll with \`cursor: null\` returned ${events.length} event(s); "start from now" replays nothing.`,
              details: { count: events.length }
            }
          )
    );

    out.push(
      isValidCursor(r.cursor)
        ? eventsCheck(
            'sep-9999-cursor-opaque',
            'Cursors are opaque strings managed by the server, representing a position in the event stream.',
            'SUCCESS',
            {
              details: {
                cursorType:
                  r.cursor === null || r.cursor === undefined
                    ? 'null'
                    : 'string'
              }
            }
          )
        : eventsCheck(
            'sep-9999-cursor-opaque',
            'Cursors are opaque strings managed by the server, representing a position in the event stream.',
            'FAILURE',
            {
              errorMessage: `\`cursor\` is ${describeValue(r.cursor)}; a cursor is an opaque string (or null when the type has no replay).`,
              details: { cursor: r.cursor }
            }
          )
    );

    return out;
  }

  /**
   * Poll twice with the cursor from the first response and check the server
   * answers the second without being told anything it was not told the first
   * time.
   *
   * This grades three rows at once: the cursor advances (or stays put
   * legitimately) during a quiet period, the request is self-contained, and an
   * omitted `cursor` field is accepted as `null`.
   */
  private async quietAdvanceChecks(
    conn: Connection,
    name: string,
    args: Record<string, unknown>,
    first: EventsPollResult
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];
    const cursor = first.cursor;
    const noReplay = cursor === null || cursor === undefined;

    const second = await eventsPoll(conn, {
      name,
      arguments: args,
      ...(noReplay ? {} : { cursor })
    });

    if ('error' in second) {
      const reason = `A follow-up \`${EVENTS_POLL_METHOD}\` carrying the cursor from the first response failed: ${second.error.code} ${second.error.message}`;
      out.push(
        eventsCheck(
          'sep-9999-poll-stateless-request',
          'Each poll request is self-contained: the server does not need to remember previous poll requests to answer them.',
          'FAILURE',
          { errorMessage: reason, details: { code: second.error.code } }
        )
      );
      out.push(
        ...untestableAll(
          [
            'sep-9999-cursor-advances-when-quiet',
            'sep-9999-cursor-consistency'
          ],
          reason
        )
      );
      out.push(
        ...untestableAll(
          ['sep-9999-cursor-absent-equals-null'],
          reason,
          'FAILURE'
        )
      );
      return out;
    }

    const r2 = second.result;

    out.push(
      eventsCheck(
        'sep-9999-poll-stateless-request',
        'Each poll request is self-contained: the server does not need to remember previous poll requests to answer them.',
        'SUCCESS',
        { details: { secondPollAccepted: true } }
      )
    );

    // Cursor advancement during a quiet period. A server with no traffic may
    // legitimately return the same cursor — the requirement is that the
    // response carries one at all, so the client's persisted position does not
    // go stale. An event type with no replay carries null both times, which is
    // equally conformant.
    out.push(
      isValidCursor(r2.cursor)
        ? eventsCheck(
            'sep-9999-cursor-advances-when-quiet',
            "Every poll response carries `cursor`, including when `events: []`, so the client's persisted cursor advances during quiet periods.",
            'SUCCESS',
            {
              details: {
                first: cursor ?? null,
                second: r2.cursor ?? null,
                advanced: (r2.cursor ?? null) !== (cursor ?? null)
              }
            }
          )
        : eventsCheck(
            'sep-9999-cursor-advances-when-quiet',
            "Every poll response carries `cursor`, including when `events: []`, so the client's persisted cursor advances during quiet periods.",
            'FAILURE',
            {
              errorMessage: `Follow-up poll returned \`cursor\` as ${describeValue(r2.cursor)}; a quiet poll must still carry a position.`,
              details: { cursor: r2.cursor }
            }
          )
    );

    // Consistency: a type that returns a cursor once returns one always.
    const firstNull = cursor === null || cursor === undefined;
    const secondNull = r2.cursor === null || r2.cursor === undefined;
    out.push(
      firstNull === secondNull
        ? eventsCheck(
            'sep-9999-cursor-consistency',
            'An event type that ever returns a non-null cursor SHOULD always do so, and one that returns `null` SHOULD always return `null`.',
            'SUCCESS',
            { details: { replaySupported: !firstNull } }
          )
        : eventsCheck(
            'sep-9999-cursor-consistency',
            'An event type that ever returns a non-null cursor SHOULD always do so, and one that returns `null` SHOULD always return `null`.',
            'WARNING',
            {
              errorMessage: `Event type \`${name}\` returned ${firstNull ? 'null' : 'a cursor'} then ${secondNull ? 'null' : 'a cursor'}; clients branch once at subscribe time on this.`,
              details: { first: cursor ?? null, second: r2.cursor ?? null }
            }
          )
    );

    // Absent means null: the second poll omitted `cursor` entirely when the
    // type has no replay, and the server answered anyway.
    out.push(
      noReplay
        ? eventsCheck(
            'sep-9999-cursor-absent-equals-null',
            'An absent `cursor` field MUST be treated identically to an explicit `cursor: null`; a receiver MUST NOT fail because it is missing.',
            'SUCCESS',
            { details: { omittedCursorAccepted: true } }
          )
        : await this.absentCursorCheck(conn, name, args)
    );

    return out;
  }

  /** Probe "absent means null" directly by omitting the field. */
  private async absentCursorCheck(
    conn: Connection,
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck> {
    const id = 'sep-9999-cursor-absent-equals-null';
    const description =
      'An absent `cursor` field MUST be treated identically to an explicit `cursor: null`; a receiver MUST NOT fail because it is missing.';
    const probe = await eventsPoll(conn, { name, arguments: args });
    if ('error' in probe) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage: `A poll omitting \`cursor\` was rejected with ${probe.error.code} ${probe.error.message}; an absent cursor means "start from now", not a malformed request.`,
        details: { code: probe.error.code, message: probe.error.message }
      });
    }
    return eventsCheck(id, description, 'SUCCESS', {
      details: { returned: occurrences(probe.result).length }
    });
  }

  /** `maxEvents` caps the batch; `hasMore` reports whether more remain. */
  private async maxEventsChecks(
    conn: Connection,
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const id = 'sep-9999-poll-max-events-cap';
    const description =
      '`maxEvents` is an optional cap on the number of events returned. If more are available, the server returns a partial batch with an intermediate cursor and sets `hasMore: true`.';

    const probe = await eventsPoll(conn, {
      name,
      arguments: args,
      cursor: null,
      maxEvents: 1
    });

    if ('error' in probe) {
      return [
        eventsCheck(id, description, 'FAILURE', {
          errorMessage: `A poll carrying \`maxEvents: 1\` was rejected with ${probe.error.code} ${probe.error.message}; \`maxEvents\` is an optional request field, not an error.`,
          details: { code: probe.error.code, message: probe.error.message }
        })
      ];
    }

    const returned = occurrences(probe.result).length;
    if (returned > 1) {
      return [
        eventsCheck(id, description, 'FAILURE', {
          errorMessage: `A poll with \`maxEvents: 1\` returned ${returned} events.`,
          details: { returned }
        })
      ];
    }

    return [
      eventsCheck(id, description, 'SUCCESS', {
        details: { returned, hasMore: probe.result.hasMore ?? false }
      })
    ];
  }

  /**
   * `maxAgeMs` and `truncated`.
   *
   * Against a quiet server the floor never advances past the cursor, so the
   * two `truncated`-setting rows cannot be driven to true. What is gradeable
   * everywhere: the field is accepted, it is ignored when the cursor is null,
   * `truncated` is a boolean rather than an error, and when it is true the
   * response still carries a fresh cursor.
   */
  private async replayChecks(
    conn: Connection,
    name: string,
    args: Record<string, unknown>,
    bootstrap: EventsPollResult
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];
    const noReplay =
      bootstrap.cursor === null || bootstrap.cursor === undefined;

    const withMaxAge = await eventsPoll(conn, {
      name,
      arguments: args,
      cursor: bootstrap.cursor ?? null,
      maxAgeMs: MAX_AGE_PROBE_MS
    });

    if ('error' in withMaxAge) {
      const reason = `A poll carrying \`maxAgeMs\` was rejected with ${withMaxAge.error.code} ${withMaxAge.error.message}.`;
      out.push(
        eventsCheck(
          'sep-9999-max-age-ms-floor',
          'All three modes accept an optional `maxAgeMs` alongside `cursor`; the server begins replay from whichever is later, the cursor or `now − maxAgeMs`.',
          'FAILURE',
          { errorMessage: reason, details: { code: withMaxAge.error.code } }
        )
      );
      out.push(
        ...untestableAll(
          [
            'sep-9999-max-age-ms-sets-truncated',
            'sep-9999-replay-ceiling-sets-truncated',
            'sep-9999-truncated-returns-fresh-cursor',
            'sep-9999-truncated-poll-never-an-error',
            'sep-9999-truncated-false-when-no-replay',
            'sep-9999-max-age-ms-ignored-when-cursor-null'
          ],
          reason,
          'WARNING'
        )
      );
      return out;
    }

    const r = withMaxAge.result;
    out.push(
      eventsCheck(
        'sep-9999-max-age-ms-floor',
        'All three modes accept an optional `maxAgeMs` alongside `cursor`; the server begins replay from whichever is later, the cursor or `now − maxAgeMs`.',
        'SUCCESS',
        { details: { maxAgeMs: MAX_AGE_PROBE_MS } }
      )
    );

    // truncated is a response field, never an error. A server that rejected
    // the maxAgeMs poll outright already failed above.
    const truncated = r.truncated;
    out.push(
      truncated === undefined || typeof truncated === 'boolean'
        ? eventsCheck(
            'sep-9999-truncated-poll-never-an-error',
            'For poll, `truncated` appears in the result body. Never a JSON-RPC error.',
            'SUCCESS',
            { details: { truncated: truncated ?? false } }
          )
        : eventsCheck(
            'sep-9999-truncated-poll-never-an-error',
            'For poll, `truncated` appears in the result body. Never a JSON-RPC error.',
            'FAILURE',
            {
              errorMessage: `\`truncated\` is ${describeValue(truncated)}, expected a boolean.`,
              details: { truncated }
            }
          )
    );

    // When truncated is true the response must still carry a servable cursor.
    out.push(
      truncated === true
        ? isValidCursor(r.cursor) && r.cursor !== null && r.cursor !== undefined
          ? eventsCheck(
              'sep-9999-truncated-returns-fresh-cursor',
              'The server resets to a position it can serve from and returns that position as the fresh `cursor` alongside `truncated: true`.',
              'SUCCESS',
              { details: { cursor: r.cursor } }
            )
          : eventsCheck(
              'sep-9999-truncated-returns-fresh-cursor',
              'The server resets to a position it can serve from and returns that position as the fresh `cursor` alongside `truncated: true`.',
              'FAILURE',
              {
                errorMessage: `\`truncated: true\` was returned with \`cursor\` as ${describeValue(r.cursor)}; the client has no fresh position to persist.`,
                details: { cursor: r.cursor }
              }
            )
        : untestableCheck(
            'sep-9999-truncated-returns-fresh-cursor',
            'sep-9999-truncated-returns-fresh-cursor',
            'The server resets to a position it can serve from and returns that position as the fresh `cursor` alongside `truncated: true`.',
            'No probe produced `truncated: true`, so the fresh-cursor obligation could not be observed. Driving it requires a stale cursor the harness cannot mint against an opaque cursor space.',
            [EVENTS_SPEC_REF],
            'WARNING'
          )
    );

    for (const id of [
      'sep-9999-max-age-ms-sets-truncated',
      'sep-9999-replay-ceiling-sets-truncated'
    ]) {
      out.push(
        untestableCheck(
          id,
          id,
          id,
          "Requires a cursor older than the `maxAgeMs` floor or the server's replay ceiling. Cursors are opaque, so the harness cannot mint a stale one, and a quiet fixture has no history to fall out of.",
          [EVENTS_SPEC_REF],
          'WARNING'
        )
      );
    }

    out.push(
      noReplay
        ? truncated === true
          ? eventsCheck(
              'sep-9999-truncated-false-when-no-replay',
              'For event types that do not support replay (`cursor` is always `null`), `truncated` SHOULD be `false`.',
              'WARNING',
              {
                errorMessage: `Event type \`${name}\` returns \`cursor: null\` (no replay) but set \`truncated: true\`; there is no position to have advanced past.`,
                details: { truncated }
              }
            )
          : eventsCheck(
              'sep-9999-truncated-false-when-no-replay',
              'For event types that do not support replay (`cursor` is always `null`), `truncated` SHOULD be `false`.',
              'SUCCESS',
              { details: { truncated: truncated ?? false } }
            )
        : eventsCheck(
            'sep-9999-truncated-false-when-no-replay',
            'For event types that do not support replay (`cursor` is always `null`), `truncated` SHOULD be `false`.',
            'SKIPPED',
            {
              errorMessage: `Event type \`${name}\` supports replay, so this rule does not apply to it.`
            }
          )
    );

    // maxAgeMs is ignored when cursor is null. Observable as "the server does
    // not replay history in response to it".
    const nullCursorMaxAge = await eventsPoll(conn, {
      name,
      arguments: args,
      cursor: null,
      maxAgeMs: MAX_AGE_PROBE_MS
    });
    const id = 'sep-9999-max-age-ms-ignored-when-cursor-null';
    const description =
      '`maxAgeMs` is ignored when `cursor` is `null` (null already means "now").';
    if ('error' in nullCursorMaxAge) {
      out.push(
        eventsCheck(id, description, 'FAILURE', {
          errorMessage: `A poll with \`cursor: null\` and \`maxAgeMs\` was rejected with ${nullCursorMaxAge.error.code} ${nullCursorMaxAge.error.message}.`,
          details: { code: nullCursorMaxAge.error.code }
        })
      );
    } else {
      const replayed = occurrences(nullCursorMaxAge.result).length;
      out.push(
        replayed === 0
          ? eventsCheck(id, description, 'SUCCESS', { details: { replayed } })
          : eventsCheck(id, description, 'FAILURE', {
              errorMessage: `A poll with \`cursor: null\` and \`maxAgeMs: ${MAX_AGE_PROBE_MS}\` replayed ${replayed} event(s); \`maxAgeMs\` is ignored when the cursor is null.`,
              details: { replayed }
            })
      );
    }

    return out;
  }

  /**
   * The `EventOccurrence` field contract.
   *
   * Only gradeable against a response that actually carried an event. A quiet
   * fixture reports the whole group as untestable rather than passing an empty
   * array through seven shape checks, which would read as green.
   */
  /**
   * Poll forward from the bootstrap cursor, waiting `nextPollMs` between
   * attempts (clamped to 250ms-2s), until a batch carries events or
   * OCCURRENCE_WAIT_MS elapses. Returns the last result either way, so a quiet
   * server still reports the occurrence checks as untestable.
   */
  private async pollForOccurrences(
    conn: Connection,
    name: string,
    args: Record<string, unknown>,
    bootstrap: EventsPollResult
  ): Promise<EventsPollResult> {
    let last = bootstrap;
    const deadline = Date.now() + OCCURRENCE_WAIT_MS;
    while (occurrences(last).length === 0 && Date.now() < deadline) {
      const hint = typeof last.nextPollMs === 'number' ? last.nextPollMs : 1000;
      const wait = Math.min(Math.max(hint, 250), 2000, deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
      const next = await eventsPoll(conn, {
        name,
        arguments: args,
        cursor: last.cursor ?? null
      });
      if ('error' in next) return last;
      last = next.result;
    }
    return last;
  }

  private occurrenceChecks(
    r: EventsPollResult,
    descriptor: EventDescriptor
  ): ConformanceCheck[] {
    const events = occurrences(r);
    if (events.length === 0) {
      return untestableAll(
        OCCURRENCE_IDS,
        'No poll returned an event, so the `EventOccurrence` shape could not be validated. The fixture needs a diagnostic event type that emits on demand.'
      );
    }

    const out: ConformanceCheck[] = [];
    const label = (e: EventOccurrence, i: number) =>
      typeof e.eventId === 'string' ? `\`${e.eventId}\`` : `events[${i}]`;

    const field = (
      id: string,
      description: string,
      severity: 'FAILURE' | 'WARNING',
      predicate: (e: EventOccurrence) => string | undefined
    ) => {
      for (const [i, e] of events.entries()) {
        const problem = predicate(e);
        if (problem) {
          out.push(
            eventsCheck(id, description, severity, {
              errorMessage: `${label(e, i)}: ${problem}`,
              details: { occurrence: e }
            })
          );
          return;
        }
      }
      out.push(
        eventsCheck(id, description, 'SUCCESS', {
          details: { occurrencesChecked: events.length }
        })
      );
    };

    field(
      'sep-9999-occurrence-event-id',
      '`eventId` (string) is required on every `EventOccurrence`: a stable identifier for deduplication.',
      'FAILURE',
      (e) =>
        typeof e.eventId === 'string' && e.eventId.length > 0
          ? undefined
          : `\`eventId\` is ${describeValue(e.eventId)}, expected a non-empty string.`
    );

    field(
      'sep-9999-occurrence-name',
      '`name` (string) is required on every `EventOccurrence`: the event type name.',
      'FAILURE',
      (e) =>
        typeof e.name === 'string' && e.name === descriptorName(descriptor)
          ? undefined
          : `\`name\` is ${JSON.stringify(e.name)}, expected \`${descriptorName(descriptor)}\`.`
    );

    field(
      'sep-9999-occurrence-timestamp',
      '`timestamp` (string, ISO 8601) is required on every `EventOccurrence`: when the event occurred.',
      'FAILURE',
      (e) =>
        isIso8601(e.timestamp)
          ? undefined
          : `\`timestamp\` is ${JSON.stringify(e.timestamp)}, expected an ISO 8601 instant.`
    );

    field(
      'sep-9999-occurrence-data',
      "`data` (object) is required on every `EventOccurrence`: payload conforming to the event type's `payloadSchema`.",
      'FAILURE',
      (e) =>
        isObject(e.data)
          ? undefined
          : `\`data\` is ${describeValue(e.data)}, expected an object.`
    );

    field(
      'sep-9999-occurrence-cursor-optional',
      '`cursor` on an `EventOccurrence` is optional; poll carries the cursor at the response level.',
      'FAILURE',
      (e) =>
        isValidCursor(e.cursor)
          ? undefined
          : `\`cursor\` is ${describeValue(e.cursor)}, expected a string, null, or absent.`
    );

    field(
      'sep-9999-occurrence-meta-ungoverned',
      '`_meta` is reserved for protocol/extension metadata and is not governed by `payloadSchema`.',
      'WARNING',
      (e) =>
        e._meta === undefined || isObject(e._meta)
          ? undefined
          : `\`_meta\` is ${describeValue(e._meta)}, expected an object when present.`
    );

    // Whether an eventId came from upstream is not observable from one run;
    // what is observable is that ids are distinct within a batch, which a
    // per-delivery counter would violate.
    const ids = events
      .map((e) => e.eventId)
      .filter((v): v is string => typeof v === 'string');
    out.push(
      new Set(ids).size === ids.length
        ? eventsCheck(
            'sep-9999-occurrence-event-id-from-upstream',
            "The server SHOULD use the upstream's stable event identifier as `eventId` so the same upstream event carries the same id across delivery paths.",
            'SUCCESS',
            { details: { distinct: new Set(ids).size, total: ids.length } }
          )
        : eventsCheck(
            'sep-9999-occurrence-event-id-from-upstream',
            "The server SHOULD use the upstream's stable event identifier as `eventId` so the same upstream event carries the same id across delivery paths.",
            'WARNING',
            {
              errorMessage:
                'A single batch repeated an `eventId`, so the value cannot be an upstream-stable identifier and client-side dedup would drop distinct events.',
              details: { ids }
            }
          )
    );

    return out;
  }

  /** The poll error contract: unknown name, bad arguments, unsupported mode. */
  private async errorChecks(
    conn: Connection,
    descriptors: EventDescriptor[],
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];

    // Unknown name.
    const unknown = unknownEventName();
    const probe = await eventsPoll(conn, {
      name: unknown,
      arguments: {},
      cursor: null
    });
    const notFoundDesc =
      'A poll against a name the server does not serve returns `-32011 NotFound`.';
    const jsonRpcDesc =
      'Errors are returned as a standard JSON-RPC error response for the request; there is no partial-success model.';

    if ('error' in probe) {
      out.push(
        eventsCheck(
          'sep-9999-poll-errors-are-jsonrpc',
          jsonRpcDesc,
          'SUCCESS',
          {
            details: { code: probe.error.code }
          }
        )
      );
      out.push(
        probe.error.code === EVENTS_NOT_FOUND
          ? eventsCheck(
              'sep-9999-removal-poll-not-found',
              notFoundDesc,
              'SUCCESS',
              {
                details: { code: probe.error.code, probedName: unknown }
              }
            )
          : eventsCheck(
              'sep-9999-removal-poll-not-found',
              notFoundDesc,
              'FAILURE',
              {
                errorMessage: `Unknown event name answered ${probe.error.code}, expected ${EVENTS_NOT_FOUND} NotFound.`,
                details: {
                  code: probe.error.code,
                  message: probe.error.message
                }
              }
            )
      );
    } else {
      const msg = `A poll for unknown event name \`${unknown}\` returned a result instead of an error.`;
      out.push(
        eventsCheck(
          'sep-9999-poll-errors-are-jsonrpc',
          jsonRpcDesc,
          'FAILURE',
          {
            errorMessage: msg,
            details: { result: probe.result }
          }
        )
      );
      out.push(
        eventsCheck(
          'sep-9999-removal-poll-not-found',
          notFoundDesc,
          'FAILURE',
          {
            errorMessage: msg
          }
        )
      );
    }

    // One subscription per request: `name` identifies it, so a poll without
    // one is not a request the server can answer.
    const noName = await eventsPoll(conn, { arguments: {}, cursor: null });
    const oneSubDesc =
      'Each `events/poll` request carries one subscription, identified by `name`.';
    out.push(
      'error' in noName
        ? noName.error.code === JSONRPC_INVALID_PARAMS
          ? eventsCheck(
              'sep-9999-poll-one-subscription-per-request',
              oneSubDesc,
              'SUCCESS',
              { details: { code: noName.error.code } }
            )
          : eventsCheck(
              'sep-9999-poll-one-subscription-per-request',
              oneSubDesc,
              'WARNING',
              {
                errorMessage: `A poll omitting \`name\` answered ${noName.error.code}, expected ${JSONRPC_INVALID_PARAMS} InvalidParams.`,
                details: {
                  code: noName.error.code,
                  message: noName.error.message
                }
              }
            )
        : eventsCheck(
            'sep-9999-poll-one-subscription-per-request',
            oneSubDesc,
            'FAILURE',
            {
              errorMessage:
                'A poll omitting `name` returned a result; each request carries exactly one subscription and `name` is what identifies it.',
              details: { result: noName.result }
            }
          )
    );

    // Invalid arguments. Only probeable when the schema constrains something.
    out.push(
      ...(await this.invalidArgumentsCheck(conn, descriptors, name, args))
    );

    // A delivery mode the event type does not offer.
    out.push(await this.unsupportedModeCheck(conn, descriptors));

    return out;
  }

  /**
   * Send arguments the descriptor's `inputSchema` cannot accept.
   *
   * Only constructible when the schema declares a typed property: a fully open
   * schema has no invalid value to send, and inventing one would grade the
   * server on a rule the schema never stated.
   */
  private async invalidArgumentsCheck(
    conn: Connection,
    descriptors: EventDescriptor[],
    name: string,
    _args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const id = 'sep-9999-poll-invalid-arguments';
    const description =
      "A poll whose `arguments` do not match the event's `inputSchema` returns `-32602 InvalidParams`.";

    const target = descriptors.find((d) => descriptorName(d) === name);
    const schema = target?.inputSchema;
    const props =
      isObject(schema) && isObject(schema.properties)
        ? schema.properties
        : undefined;
    const typed = props
      ? Object.entries(props).find(
          ([, v]) =>
            isObject(v) &&
            typeof v.type === 'string' &&
            ['string', 'boolean', 'integer', 'number'].includes(v.type)
        )
      : undefined;

    if (!typed) {
      return withErrorCodeRow(
        untestableCheck(
          id,
          id,
          description,
          `Event type \`${name}\` declares no typed \`inputSchema\` property, so no argument value can be known-invalid against it.`,
          [EVENTS_SPEC_REF],
          'FAILURE'
        )
      );
    }

    const [prop, spec] = typed;
    const propType = (spec as Record<string, unknown>).type as string;
    // A value of the wrong JSON type for the declared one.
    const wrongValue = propType === 'string' ? 12345 : 'not-a-valid-value';

    const probe = await eventsPoll(conn, {
      name,
      arguments: { [prop]: wrongValue },
      cursor: null
    });

    if (!('error' in probe)) {
      return withErrorCodeRow(
        eventsCheck(id, description, 'FAILURE', {
          errorMessage: `A poll sending \`${prop}: ${JSON.stringify(wrongValue)}\` against a declared \`${propType}\` returned a result instead of ${JSONRPC_INVALID_PARAMS} InvalidParams.`,
          details: { property: prop, declaredType: propType, sent: wrongValue }
        })
      );
    }

    return withErrorCodeRow(
      probe.error.code === JSONRPC_INVALID_PARAMS
        ? eventsCheck(id, description, 'SUCCESS', {
            details: { property: prop, declaredType: propType }
          })
        : eventsCheck(id, description, 'FAILURE', {
            errorMessage: `Arguments violating \`inputSchema\` answered ${probe.error.code}, expected ${JSONRPC_INVALID_PARAMS} InvalidParams.`,
            details: {
              property: prop,
              declaredType: propType,
              code: probe.error.code,
              message: probe.error.message
            }
          })
    );
  }

  /** Poll an event type whose `delivery` omits `poll`. */
  private async unsupportedModeCheck(
    conn: Connection,
    descriptors: EventDescriptor[]
  ): Promise<ConformanceCheck> {
    const id = 'sep-9999-poll-mode-unsupported';
    const description =
      'A poll against an event type whose `delivery` does not list `poll` returns `-32014 Unsupported`.';

    const nonPoll = descriptors.find(
      (d) =>
        descriptorName(d) !== undefined && !deliveryModes(d).includes('poll')
    );
    if (!nonPoll) {
      return untestableCheck(
        id,
        id,
        description,
        'Every event type the server offers advertises `poll` delivery, so there is no event type to probe the unsupported-mode path with.',
        [EVENTS_SPEC_REF],
        'FAILURE'
      );
    }

    const name = descriptorName(nonPoll)!;
    const probe = await eventsPoll(conn, {
      name,
      arguments: minimalArguments(nonPoll) ?? {},
      cursor: null
    });

    if (!('error' in probe)) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage: `Event type \`${name}\` does not advertise \`poll\` delivery (\`delivery\` is ${JSON.stringify(nonPoll.delivery)}) but \`${EVENTS_POLL_METHOD}\` returned a result.`,
        details: { name, delivery: deliveryModes(nonPoll) }
      });
    }

    return probe.error.code === EVENTS_UNSUPPORTED
      ? eventsCheck(id, description, 'SUCCESS', {
          details: { name, code: probe.error.code, data: probe.error.data }
        })
      : eventsCheck(id, description, 'FAILURE', {
          errorMessage: `Polling \`${name}\`, which does not offer poll delivery, answered ${probe.error.code}, expected ${EVENTS_UNSUPPORTED} Unsupported.`,
          details: {
            name,
            delivery: deliveryModes(nonPoll),
            code: probe.error.code,
            message: probe.error.message
          }
        });
  }
}

/** Exported for the negative tests, which assert the full emitted set. */
export const EVENTS_POLL_CHECK_IDS = ALL_IDS;
