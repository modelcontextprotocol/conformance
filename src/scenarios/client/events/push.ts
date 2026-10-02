/**
 * Events client, push mode.
 *
 * Each type's first stream confirms with `notifications/events/active`,
 * delivers one event, sends four heartbeats 500ms apart, then goes silent
 * without closing. Later streams heartbeat until the client hangs up. The sketch says a client SHOULD treat
 * a stream as dead after two heartbeat intervals of silence and reconnect with
 * its cursor.
 *
 * The heartbeat interval is never announced to the client, so this grades the
 * reconnect inside the run window only, as a WARNING. A client that assumes
 * the 30s maximum would need over a minute to notice. "Do not apply the
 * default request timeout to events/stream" needs a window longer than any
 * client's default timeout, and stays excluded in sep-9999.yaml for now
 * (modelcontextprotocol/conformance#540).
 */

import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import {
  EVENTS_ACTIVE_NOTIFICATION,
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_HEARTBEAT_NOTIFICATION,
  EVENTS_STREAM_METHOD,
  SUBSCRIPTION_ID_META
} from '../../server/events/helpers.js';
import {
  CURSORLESS_TYPE,
  EventsClientScenarioBase,
  REPLAY_TYPE,
  clientUntestable,
  cursorOf,
  graded
} from './helpers.js';

const HEARTBEAT_MS = 500;
const HEARTBEATS_BEFORE_SILENCE = 4;

export class EventsClientPushScenario extends EventsClientScenarioBase {
  name = 'events-client-push';
  description =
    'Events client, push mode: treats a silent stream as dead and reconnects with its cursor, and never replays a null cursor.';
  protected durationMs = 9000;
  protected mode = 'push' as const;

  /** The last cursor each type's first stream sent before going silent. */
  private lastCursor = new Map<string, string | null>();
  private timers = new Set<NodeJS.Timeout>();

  async start(ctx: Parameters<EventsClientScenarioBase['start']>[0]) {
    this.lastCursor = new Map();
    return super.start(ctx);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.server?.closeAllConnections?.();
    return super.stop();
  }

  protected handleEvents(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): boolean {
    if (request.method !== EVENTS_STREAM_METHOD) return false;
    const name = String(request.params?.name);
    const first = this.requestsFor(EVENTS_STREAM_METHOD, name).length === 1;
    const replay = name === REPLAY_TYPE;
    const meta = { [SUBSCRIPTION_ID_META]: request.id };
    const send = this.openSse(res);

    let n = 0;
    const position = () => (replay ? `p-${n}` : null);
    send({
      jsonrpc: '2.0',
      method: EVENTS_ACTIVE_NOTIFICATION,
      params: { cursor: position(), truncated: false, _meta: meta }
    });
    send({
      jsonrpc: '2.0',
      method: EVENTS_EVENT_NOTIFICATION,
      params: {
        eventId: `${name}-1`,
        name,
        timestamp: new Date().toISOString(),
        data: {},
        cursor: position(),
        _meta: meta
      }
    });

    const timer = setInterval(() => {
      if (first && n >= HEARTBEATS_BEFORE_SILENCE) {
        clearInterval(timer);
        this.timers.delete(timer);
        return;
      }
      n++;
      send({
        jsonrpc: '2.0',
        method: EVENTS_HEARTBEAT_NOTIFICATION,
        params: { cursor: position(), _meta: meta }
      });
      if (first) this.lastCursor.set(name, position());
    }, HEARTBEAT_MS);
    this.timers.add(timer);
    const done = () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
    // `res`, not `req`: Node closes the request side as soon as the body has
    // been read, long before the client hangs up.
    res.on('close', done);
    return true;
  }

  getChecks(): ConformanceCheck[] {
    const checks: ConformanceCheck[] = [];
    const ticks = this.requestsFor(EVENTS_STREAM_METHOD, REPLAY_TYPE);

    const RECONNECT_ID = 'sep-9999-client-stream-reconnect-with-cursor';
    const RECONNECT_DESC =
      'A client that has received neither an event nor a heartbeat for more than twice the heartbeat interval SHOULD treat the stream as dead and reconnect with its cursor.';
    const expected = this.lastCursor.get(REPLAY_TYPE);
    if (ticks.length === 0) {
      checks.push(
        clientUntestable(
          RECONNECT_ID,
          RECONNECT_DESC,
          `the client never opened a stream for ${REPLAY_TYPE}`,
          'WARNING'
        )
      );
    } else if (ticks.length === 1) {
      checks.push(
        graded(
          RECONNECT_ID,
          RECONNECT_DESC,
          false,
          'WARNING',
          `The stream for ${REPLAY_TYPE} heartbeat every ${HEARTBEAT_MS}ms and then went silent, and the client did not reconnect within the ${this.durationMs / 1000}s run.`
        )
      );
    } else {
      const sent = cursorOf(ticks[1].params);
      checks.push(
        graded(
          RECONNECT_ID,
          RECONNECT_DESC,
          sent === expected,
          'WARNING',
          `The client reconnected with cursor ${JSON.stringify(sent)}; the last heartbeat before the silence carried ${JSON.stringify(expected)}.`
        )
      );
    }

    const NULL_ID = 'sep-9999-client-null-cursor-not-replayed';
    const NULL_DESC =
      'A client receiving `cursor: null` MUST NOT attempt to persist or replay from it; on reconnect/resubscribe it sends `cursor: null`.';
    const later = this.requestsFor(EVENTS_STREAM_METHOD, CURSORLESS_TYPE).slice(
      1
    );
    const replayed = later.filter((r) => cursorOf(r.params) !== null);
    checks.push(
      later.length === 0
        ? clientUntestable(
            NULL_ID,
            NULL_DESC,
            `the client never reconnected its ${CURSORLESS_TYPE} stream, so no reconnect cursor was sent`,
            'FAILURE'
          )
        : graded(
            NULL_ID,
            NULL_DESC,
            replayed.length === 0,
            'FAILURE',
            `Every frame for ${CURSORLESS_TYPE} carried a null cursor, and the client reconnected with ${replayed.map((r) => JSON.stringify(r.params.cursor)).join(', ')}.`
          )
    );

    return checks;
  }
}
