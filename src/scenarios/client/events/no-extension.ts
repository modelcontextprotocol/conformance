/**
 * Events client against a server that does not declare the extension.
 *
 * A separate scenario because one mock cannot both declare the extension and
 * not declare it. The server still answers `events/list` and `events/poll`,
 * so a client that skips the capability check gets far enough to be caught.
 */

import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import { EVENTS_POLL_METHOD } from '../../server/events/helpers.js';
import {
  EVENTS_EXTENSION_ID,
  EventsClientScenarioBase,
  clientUntestable,
  graded
} from './helpers.js';

export class EventsClientNoExtensionScenario extends EventsClientScenarioBase {
  name = 'events-client-no-extension';
  description =
    'Events client against a server that does not declare the extension: the client MUST NOT send any events/* request.';
  protected durationMs = 2000;
  protected mode = 'poll' as const;

  protected eventsSettings(): undefined {
    return undefined;
  }

  protected handleEvents(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): boolean {
    if (request.method !== EVENTS_POLL_METHOD) return false;
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: { events: [], cursor: null, hasMore: false, nextPollMs: 1000 }
    });
    return true;
  }

  getChecks(): ConformanceCheck[] {
    const ID = 'sep-9999-client-no-events-without-extension';
    const DESC =
      'All `events/*` requests are client-initiated, so a client MUST NOT send them to a server that has not advertised the extension.';
    if (!this.clientConnected()) {
      return [
        clientUntestable(
          ID,
          DESC,
          'the client never contacted the server, so there was no capability declaration to respect',
          'FAILURE'
        )
      ];
    }
    const sent = this.requests.filter((r) => r.method.startsWith('events/'));
    return [
      graded(
        ID,
        DESC,
        sent.length === 0,
        'FAILURE',
        `The server declared no \`${EVENTS_EXTENSION_ID}\` extension and the client sent ${sent.map((r) => r.method).join(', ')}.`
      )
    ];
  }
}
