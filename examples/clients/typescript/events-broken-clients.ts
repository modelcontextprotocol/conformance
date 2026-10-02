/**
 * Deliberately broken Events clients for the negative tests in
 * src/scenarios/client/events/events.test.ts. Each one is the conformant
 * client from events-client.ts with exactly one behaviour switched off, so a
 * flipped check names the rule it caught.
 */

import {
  CONFORMANT,
  EventsClientOptions,
  makeEventsClient
} from './events-client.js';

function broken(change: Partial<EventsClientOptions>) {
  return makeEventsClient({ ...CONFORMANT, ...change });
}

export const ignoresExtensionGate = broken({ gateOnExtension: false });
export const noDrainOnHasMore = broken({ drainOnHasMore: false });
export const ignoresNextPollMs = broken({ respectNextPollMs: false });
export const noPollFloor = broken({ pollFloorMs: 0 });
export const dropsTruncatedCursor = broken({ persistTruncatedCursor: false });
export const replaysNullCursor = broken({ replayNullCursor: true });
export const failsOnAbsentCursor = broken({ tolerateAbsentCursor: false });
export const ignoresListChanged = broken({ relistOnListChanged: false });
export const refreshesAfterExpiry = broken({ refreshBeforeExpiry: false });
export const neverReconnects = broken({ reconnectDeadStream: false });
