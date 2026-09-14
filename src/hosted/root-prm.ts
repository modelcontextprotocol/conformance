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
 * answered a request from the same client address with a sign-in challenge
 * (401), within ROOT_PRM_WINDOW_MS. The challenge is noted in the run store
 * (SessionManager.noteChallenge) with a keyed hash of the address, never the
 * address itself, so the cell is found whichever process sent it, and one
 * tester's request is never answered as, or recorded in, another tester's
 * run. The cell records how the request came to it, naming no other run: a
 * run id is all it takes to read that run's results. With nothing to
 * attribute it to, the request is a 404 that says what to do.
 */

import { createHmac, randomBytes } from 'crypto';
import type { Request } from 'express';
import type { ConformanceCheck } from '../types';

export const ROOT_PRM_PATH = '/.well-known/oauth-protected-resource';

/** How far back a sign-in challenge can explain an origin-root request. */
export const ROOT_PRM_WINDOW_MS = 120_000;

export const ROOT_PRM_ATTRIBUTED_CHECK_ID = 'hosted-root-prm-attributed';
export const ROOT_PRM_AMBIGUOUS_CHECK_ID = 'hosted-root-prm-ambiguous';

const WINDOW_S = ROOT_PRM_WINDOW_MS / 1000;

/**
 * The client's address as this server can trust it, or '' with none.
 *
 * Express's req.ip is the socket's address, or what the proxies the app's
 * `trust proxy` setting names attest. Behind the fetch bridge
 * (examples/hosted/fetch-bridge.ts, val.town) there is no socket, so it is
 * the last X-Forwarded-For hop: the one the platform's edge appended. The
 * hops before it are whatever the client sent, so they are never read.
 */
function clientAddress(req: Request): string {
  const direct = req.ip;
  const address =
    direct ||
    (req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean)
      .pop() ||
    '';
  return address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
}

/**
 * Who sent a request, as a keyed hash of the client's address ('' when the
 * address is unknown). The key is the deployment's relay secret, which every
 * process of a deployment that needs a relay shares, so every process
 * computes the same hash and none stores an address. Without one, each
 * process picks its own key, which is enough for a single process.
 */
export function requesterHasher(
  secret: string | undefined
): (req: Request) => string {
  const key = secret || randomBytes(32).toString('hex');
  return (req) => {
    const address = clientAddress(req);
    if (!address) return '';
    return createHmac('sha256', key)
      .update(`root-prm-requester:${address}`)
      .digest('base64url')
      .slice(0, 22);
  };
}

/**
 * The note on the cell an origin-root request was answered as.
 * `byAddress` says whether the request was matched to this cell's challenge
 * by the client's address, or the server could not tell clients apart.
 */
export function rootPrmAttributedCheck(byAddress: boolean): ConformanceCheck {
  return {
    id: ROOT_PRM_ATTRIBUTED_CHECK_ID,
    name: 'RootPrmAttributed',
    description:
      `The client asked for protected resource metadata at the origin root (${ROOT_PRM_PATH}), ` +
      'a URL every cell on this server shares. This scenario serves its metadata there, so the ' +
      `request was answered as this cell's: the cell was the latest, within ${WINDOW_S} seconds, ` +
      (byAddress
        ? 'to answer a request from the same client address with a sign-in challenge (401)'
        : 'to answer a request with a sign-in challenge (401). This server could not see client addresses, so it could not tell clients apart'),
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      path: ROOT_PRM_PATH,
      windowSeconds: WINDOW_S,
      matchedBy: byAddress ? 'client-address' : 'latest-challenge'
    }
  };
}

/**
 * The note when other cells were challenged in the same window. It names
 * their revision and scenario only, never their run id: a run id is all it
 * takes to read a run's results, and the other cells may be someone else's.
 */
export function rootPrmAmbiguousCheck(
  otherCells: ReadonlyArray<{ revision: string; scenario: string }>,
  byAddress: boolean
): ConformanceCheck {
  const n = otherCells.length;
  const cells = n === 1 ? '1 other cell' : `${n} other cells`;
  return {
    id: ROOT_PRM_AMBIGUOUS_CHECK_ID,
    name: 'RootPrmAmbiguous',
    description:
      `${cells} that serve${n === 1 ? 's' : ''} metadata at the origin root also answered ` +
      (byAddress ? 'a request from the same client address ' : 'a request ') +
      `with a sign-in challenge in those ${WINDOW_S} seconds, and the request went to this cell as the latest. ` +
      'If the flow belonged to another cell, run such cells one at a time',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      path: ROOT_PRM_PATH,
      otherCellCount: n,
      otherCells: otherCells.map(({ revision, scenario }) => ({
        revision,
        scenario
      }))
    }
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
      `Open your ${names} cell URL first, from the same client. A request for ${ROOT_PRM_PATH} names no cell, ` +
      'so this server answers it as the cell of such a scenario that most recently answered ' +
      'a request from the same client address with a sign-in challenge (401), and none has ' +
      `in the last ${WINDOW_S} seconds.`,
    scenarios
  };
}
