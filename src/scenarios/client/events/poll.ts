/**
 * Events client, poll mode.
 *
 * The replay type answers a scripted sequence, one step per poll, and each
 * step sets up exactly one thing the next poll reveals:
 *
 *   0  hasMore: true, nextPollMs 3000   -> next poll should come at once
 *   1  hasMore: false, nextPollMs 2000  -> next poll should wait ~2s
 *   2  nextPollMs: 0                    -> next poll should wait the 1s floor
 *   3  truncated: true, fresh cursor    -> next poll should carry that cursor
 *   4  list_changed on the SSE response -> client should re-call events/list
 *
 * The cursorless type answers `cursor: null` once and then omits the field,
 * which the sketch says means the same thing. A client must keep polling it
 * with a null cursor and must not fail on the missing field.
 *
 * Timing thresholds are loose on purpose (1000ms for "at once", 90% of the
 * requested wait otherwise) so CI scheduling noise cannot flip a check.
 */

import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import {
  EVENTS_LIST_CHANGED_NOTIFICATION,
  EVENTS_LIST_METHOD,
  EVENTS_POLL_METHOD
} from '../../server/events/helpers.js';
import {
  CURSORLESS_TYPE,
  EventsClientScenarioBase,
  REPLAY_TYPE,
  clientUntestable,
  cursorOf,
  graded
} from './helpers.js';

const FRESH_CURSOR = 'tick-fresh';
const HAS_MORE_NEXT_POLL_MS = 3000;
const REQUESTED_WAIT_MS = 2000;
const DRAIN_WITHIN_MS = 1000;
const FLOOR_MS = 1000;

export class EventsClientPollScenario extends EventsClientScenarioBase {
  name = 'events-client-poll';
  description =
    'Events client, poll mode: drains on hasMore, honours nextPollMs and the poll floor, persists the fresh cursor after truncated, never replays a null cursor, tolerates an absent cursor, and re-lists after list_changed.';
  protected durationMs = 10000;
  protected mode = 'poll' as const;

  private listChangedSentAt: number | undefined;

  async start(ctx: Parameters<EventsClientScenarioBase['start']>[0]) {
    this.listChangedSentAt = undefined;
    return super.start(ctx);
  }

  protected eventsSettings(): object {
    return { listChanged: true };
  }

  protected handleEvents(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): boolean {
    if (request.method !== EVENTS_POLL_METHOD) return false;
    const name = request.params?.name;
    const step = this.requestsFor(EVENTS_POLL_METHOD, name).length - 1;
    const reply = (result: object) =>
      this.sendJson(res, { jsonrpc: '2.0', id: request.id, result });

    if (name === CURSORLESS_TYPE) {
      const result: Record<string, unknown> = {
        events:
          step === 0 ? [occurrence(CURSORLESS_TYPE, 'cursorless-1', null)] : [],
        hasMore: false,
        nextPollMs: 1000
      };
      if (step === 0) result.cursor = null;
      reply(result);
      return true;
    }

    switch (step) {
      case 0:
        reply({
          events: [occurrence(REPLAY_TYPE, 'tick-1', 'tick-1')],
          cursor: 'tick-1',
          hasMore: true,
          nextPollMs: HAS_MORE_NEXT_POLL_MS
        });
        return true;
      case 1:
        reply({
          events: [occurrence(REPLAY_TYPE, 'tick-2', 'tick-2')],
          cursor: 'tick-2',
          hasMore: false,
          nextPollMs: REQUESTED_WAIT_MS
        });
        return true;
      case 2:
        reply({ events: [], cursor: 'tick-3', hasMore: false, nextPollMs: 0 });
        return true;
      case 3:
        reply({
          events: [],
          cursor: FRESH_CURSOR,
          truncated: true,
          hasMore: false,
          nextPollMs: 0
        });
        return true;
      case 4: {
        const send = this.openSse(res);
        send({ jsonrpc: '2.0', method: EVENTS_LIST_CHANGED_NOTIFICATION });
        this.listChangedSentAt = Date.now();
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            events: [],
            cursor: 'tick-5',
            hasMore: false,
            nextPollMs: 1000
          }
        });
        res.end();
        return true;
      }
      default:
        reply({
          events: [],
          cursor: 'tick-6',
          hasMore: false,
          nextPollMs: 1000
        });
        return true;
    }
  }

  getChecks(): ConformanceCheck[] {
    const ticks = this.requestsFor(EVENTS_POLL_METHOD, REPLAY_TYPE);
    const cursorless = this.requestsFor(EVENTS_POLL_METHOD, CURSORLESS_TYPE);
    const gap = (i: number) => ticks[i + 1].at - ticks[i].at;
    const missing = (n: number) =>
      `the client sent ${ticks.length} poll(s) for ${REPLAY_TYPE}, and this check needs poll ${n + 1}`;
    const checks: ConformanceCheck[] = [];

    const DRAIN_ID = 'sep-9999-client-poll-drain-on-has-more';
    const DRAIN_DESC =
      'When `hasMore` is true the client SHOULD poll again immediately, ignoring `nextPollMs`.';
    checks.push(
      ticks.length < 2
        ? clientUntestable(DRAIN_ID, DRAIN_DESC, missing(1), 'WARNING')
        : graded(
            DRAIN_ID,
            DRAIN_DESC,
            gap(0) < DRAIN_WITHIN_MS,
            'WARNING',
            `After \`hasMore: true\` with \`nextPollMs: ${HAS_MORE_NEXT_POLL_MS}\`, the next poll came ${gap(0)}ms later, not within ${DRAIN_WITHIN_MS}ms.`,
            { gapMs: gap(0) }
          )
    );

    const RESPECT_ID = 'sep-9999-client-poll-respects-next-poll-ms';
    const RESPECT_DESC =
      '`nextPollMs` lets the server control polling frequency. Clients SHOULD respect it.';
    checks.push(
      ticks.length < 3
        ? clientUntestable(RESPECT_ID, RESPECT_DESC, missing(2), 'WARNING')
        : graded(
            RESPECT_ID,
            RESPECT_DESC,
            gap(1) >= REQUESTED_WAIT_MS * 0.9,
            'WARNING',
            `The server answered \`nextPollMs: ${REQUESTED_WAIT_MS}\` and the next poll came ${gap(1)}ms later.`,
            { gapMs: gap(1) }
          )
    );

    const FLOOR_ID = 'sep-9999-client-poll-floor';
    const FLOOR_DESC =
      'Clients SHOULD apply a configurable floor (default 1000 ms) to guard against a misbehaving server inducing a tight loop.';
    checks.push(
      ticks.length < 4
        ? clientUntestable(FLOOR_ID, FLOOR_DESC, missing(3), 'WARNING')
        : graded(
            FLOOR_ID,
            FLOOR_DESC,
            gap(2) >= FLOOR_MS * 0.9,
            'WARNING',
            `The server answered \`nextPollMs: 0\` and the next poll came ${gap(2)}ms later, under the ${FLOOR_MS}ms default floor.`,
            { gapMs: gap(2) }
          )
    );

    const TRUNC_ID = 'sep-9999-client-truncated-persists-fresh-cursor';
    const TRUNC_DESC =
      '`truncated: true` always implies a possible gap; clients SHOULD treat it as such and persist the fresh cursor.';
    checks.push(
      ticks.length < 5
        ? clientUntestable(TRUNC_ID, TRUNC_DESC, missing(4), 'WARNING')
        : graded(
            TRUNC_ID,
            TRUNC_DESC,
            cursorOf(ticks[4].params) === FRESH_CURSOR,
            'WARNING',
            `After \`truncated: true\` with cursor \`${FRESH_CURSOR}\`, the next poll sent cursor ${JSON.stringify(cursorOf(ticks[4].params))}.`
          )
    );

    const RELIST_ID = 'sep-9999-client-relist-on-list-changed';
    const RELIST_DESC =
      'On `notifications/events/list_changed` the client SHOULD re-call `events/list` to refresh its event type registry.';
    const sentAt = this.listChangedSentAt;
    checks.push(
      sentAt === undefined
        ? clientUntestable(
            RELIST_ID,
            RELIST_DESC,
            `${missing(4)}, which is the response that carries the notification`,
            'WARNING'
          )
        : graded(
            RELIST_ID,
            RELIST_DESC,
            this.requestsFor(EVENTS_LIST_METHOD).some((r) => r.at >= sentAt),
            'WARNING',
            'The client received `notifications/events/list_changed` on a poll response and never called `events/list` again.'
          )
    );

    const NULL_ID = 'sep-9999-client-null-cursor-not-replayed';
    const NULL_DESC =
      'A client receiving `cursor: null` MUST NOT attempt to persist or replay from it; on reconnect/resubscribe it sends `cursor: null`.';
    const later = cursorless.slice(1);
    const replayed = later.filter((r) => cursorOf(r.params) !== null);
    checks.push(
      later.length === 0
        ? clientUntestable(
            NULL_ID,
            NULL_DESC,
            `the client polled ${CURSORLESS_TYPE} ${cursorless.length} time(s), and this check needs a second poll`,
            'FAILURE'
          )
        : graded(
            NULL_ID,
            NULL_DESC,
            replayed.length === 0,
            'FAILURE',
            `Every response for ${CURSORLESS_TYPE} carried a null cursor, and ${replayed.length} later poll(s) sent a cursor anyway: ${replayed.map((r) => JSON.stringify(r.params.cursor)).join(', ')}.`
          )
    );

    const ABSENT_ID = 'sep-9999-client-cursor-absent-tolerated';
    const ABSENT_DESC =
      'An absent `cursor` field MUST be treated identically to an explicit `cursor: null`; a receiver MUST NOT fail because it is missing.';
    checks.push(
      cursorless.length < 2
        ? clientUntestable(
            ABSENT_ID,
            ABSENT_DESC,
            `the client polled ${CURSORLESS_TYPE} ${cursorless.length} time(s), so it never received the response that omits \`cursor\``,
            'FAILURE'
          )
        : graded(
            ABSENT_ID,
            ABSENT_DESC,
            cursorless.length >= 3,
            'FAILURE',
            `The client stopped polling ${CURSORLESS_TYPE} after a response that omitted \`cursor\`.`,
            { polls: cursorless.length }
          )
    );

    return checks;
  }
}

function occurrence(name: string, eventId: string, cursor: string | null) {
  return {
    eventId,
    name,
    timestamp: new Date().toISOString(),
    data: { eventId },
    cursor
  };
}
