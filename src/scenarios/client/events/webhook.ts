/**
 * Events client, webhook mode.
 *
 * Every grant expires 2.5s out, so a run of a few seconds sees several
 * refreshes. The harness never POSTs to the callback: receiver obligations
 * (signature verification, timestamp window, dedup) are graded nowhere yet,
 * and this scenario only watches the subscribe calls.
 */

import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import { EVENTS_SUBSCRIBE_METHOD } from '../../server/events/helpers.js';
import {
  CURSORLESS_TYPE,
  EventsClientScenarioBase,
  REPLAY_TYPE,
  RecordedRequest,
  clientUntestable,
  cursorOf,
  graded
} from './helpers.js';

const GRANT_MS = 2500;

interface Grant {
  at: number;
  refreshBefore: number;
}

export class EventsClientWebhookScenario extends EventsClientScenarioBase {
  name = 'events-client-webhook';
  description =
    'Events client, webhook mode: re-calls events/subscribe with the same subscription key before refreshBefore, and never replays a null cursor.';
  protected durationMs = 8000;
  protected mode = 'webhook' as const;

  /** The grant answered to each subscribe, keyed by event type. */
  private grants = new Map<string, Grant[]>();

  async start(ctx: Parameters<EventsClientScenarioBase['start']>[0]) {
    this.grants = new Map();
    return super.start(ctx);
  }

  protected handleEvents(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): boolean {
    if (request.method !== EVENTS_SUBSCRIBE_METHOD) return false;
    const name = String(request.params?.name);
    const n = this.requestsFor(EVENTS_SUBSCRIBE_METHOD, name).length;
    const refreshBefore = Date.now() + GRANT_MS;
    const list = this.grants.get(name) ?? [];
    list.push({ at: Date.now(), refreshBefore });
    this.grants.set(name, list);

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        id: `sub-${name}`,
        cursor: name === REPLAY_TYPE ? `w-${n}` : null,
        refreshBefore: new Date(refreshBefore).toISOString()
      }
    });
    return true;
  }

  getChecks(): ConformanceCheck[] {
    const checks: ConformanceCheck[] = [];
    const subs = this.requestsFor(EVENTS_SUBSCRIBE_METHOD, REPLAY_TYPE);
    const grants = this.grants.get(REPLAY_TYPE) ?? [];

    const REFRESH_ID = 'sep-9999-client-refresh-before-expiry';
    const REFRESH_DESC =
      'Unless granted no expiry, the client MUST re-call `events/subscribe` with the same subscription key before `refreshBefore` to keep the subscription alive.';
    if (subs.length < 2) {
      checks.push(
        clientUntestable(
          REFRESH_ID,
          REFRESH_DESC,
          subs.length === 0
            ? `the client never subscribed to ${REPLAY_TYPE}`
            : `the client subscribed to ${REPLAY_TYPE} once and never refreshed, with every grant ${GRANT_MS}ms long`,
          'FAILURE'
        )
      );
    } else {
      const late = subs
        .slice(1)
        .map((r, i) => ({ r, grant: grants[i] }))
        .filter(({ r, grant }) => r.at >= grant.refreshBefore);
      const changed = subs.slice(1).filter((r) => !sameKey(subs[0], r));
      const problems = [
        ...late.map(
          ({ r, grant }) =>
            `a refresh arrived ${r.at - grant.refreshBefore}ms after the grant expired`
        ),
        ...changed.map(
          () =>
            'a refresh changed the subscription key (url, name or arguments)'
        )
      ];
      checks.push(
        graded(
          REFRESH_ID,
          REFRESH_DESC,
          problems.length === 0,
          'FAILURE',
          problems.join('; '),
          { subscribes: subs.length, grantMs: GRANT_MS }
        )
      );
    }

    const NULL_ID = 'sep-9999-client-null-cursor-not-replayed';
    const NULL_DESC =
      'A client receiving `cursor: null` MUST NOT attempt to persist or replay from it; on reconnect/resubscribe it sends `cursor: null`.';
    const later = this.requestsFor(
      EVENTS_SUBSCRIBE_METHOD,
      CURSORLESS_TYPE
    ).slice(1);
    const replayed = later.filter((r) => cursorOf(r.params) !== null);
    checks.push(
      later.length === 0
        ? clientUntestable(
            NULL_ID,
            NULL_DESC,
            `the client never resubscribed to ${CURSORLESS_TYPE}, so no resubscribe cursor was sent`,
            'FAILURE'
          )
        : graded(
            NULL_ID,
            NULL_DESC,
            replayed.length === 0,
            'FAILURE',
            `Every grant for ${CURSORLESS_TYPE} carried a null cursor, and ${replayed.length} resubscribe(s) sent a cursor anyway: ${replayed.map((r) => JSON.stringify(r.params.cursor)).join(', ')}.`
          )
    );

    return checks;
  }
}

/** The subscription key is (principal, delivery.url, name, arguments). */
function sameKey(a: RecordedRequest, b: RecordedRequest): boolean {
  const url = (r: RecordedRequest) =>
    (r.params.delivery as { url?: unknown } | undefined)?.url;
  return (
    url(a) === url(b) &&
    a.params.name === b.params.name &&
    JSON.stringify(a.params.arguments ?? {}) ===
      JSON.stringify(b.params.arguments ?? {})
  );
}
