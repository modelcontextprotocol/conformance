/**
 * The origin-root protected resource metadata: a URL no cell owns.
 *
 * RFC 9728 puts a resource's metadata at
 * `<origin>/.well-known/oauth-protected-resource<path>`. A client pointed at
 * `<origin>/s/<cell>/mcp` tries that path-inserted URL first, and the hosted
 * server routes it by the cell in its path (./server.ts). A scenario that
 * serves its metadata only at the origin root (Scenario.servesRootPrm:
 * auth/metadata-var2) answers that URL 404 and names no metadata URL in its
 * WWW-Authenticate header, so a client that follows the specification falls
 * back to `<origin>/.well-known/oauth-protected-resource`: one URL for every
 * cell on the server.
 *
 * That request is answered as the cell of such a scenario that most recently
 * answered a request with a sign-in challenge (401), within ROOT_PRM_WINDOW_MS.
 * The challenge is noted in the run store (SessionManager.noteChallenge), so
 * the cell is found whichever process sent it, and the cell records how the
 * request came to it. With nothing to attribute it to, the request is a 404
 * that says what to do.
 */

import type { ConformanceCheck } from '../types';

export const ROOT_PRM_PATH = '/.well-known/oauth-protected-resource';

/** How far back a sign-in challenge can explain an origin-root request. */
export const ROOT_PRM_WINDOW_MS = 120_000;

export const ROOT_PRM_ATTRIBUTED_CHECK_ID = 'hosted-root-prm-attributed';
export const ROOT_PRM_AMBIGUOUS_CHECK_ID = 'hosted-root-prm-ambiguous';

const WINDOW_S = ROOT_PRM_WINDOW_MS / 1000;

/** The note on the cell an origin-root request was answered as. */
export function rootPrmAttributedCheck(): ConformanceCheck {
  return {
    id: ROOT_PRM_ATTRIBUTED_CHECK_ID,
    name: 'RootPrmAttributed',
    description:
      `The client asked for protected resource metadata at the origin root (${ROOT_PRM_PATH}), ` +
      'a URL every cell on this server shares. This scenario serves its metadata there, so the ' +
      `request was answered as this cell's: the cell was the latest, within ${WINDOW_S} seconds, ` +
      'to answer a request with a sign-in challenge (401)',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { path: ROOT_PRM_PATH, windowSeconds: WINDOW_S }
  };
}

/** The note when other cells were challenged in the same window. */
export function rootPrmAmbiguousCheck(otherCells: string[]): ConformanceCheck {
  return {
    id: ROOT_PRM_AMBIGUOUS_CHECK_ID,
    name: 'RootPrmAmbiguous',
    description:
      `Other cells that serve metadata at the origin root also answered with a sign-in challenge in those ${WINDOW_S} seconds, ` +
      'and the request went to this cell as the latest. If the flow belonged to another cell, ' +
      'run such cells one at a time',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { path: ROOT_PRM_PATH, otherCells }
  };
}

/** The answer when no cell was challenged recently enough. */
export function rootPrmUnattributed(scenarios: readonly string[]): {
  error: string;
  error_description: string;
  scenarios: readonly string[];
} {
  const names = scenarios.join(' or ') || 'a scenario that serves it';
  return {
    error: 'not_found',
    error_description:
      `Open your ${names} cell URL first. A request for ${ROOT_PRM_PATH} names no cell, ` +
      'so this server answers it as the cell of such a scenario that most recently answered ' +
      `a request with a sign-in challenge (401), and none has in the last ${WINDOW_S} seconds.`,
    scenarios
  };
}
