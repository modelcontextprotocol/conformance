/**
 * A callback endpoint for the webhook-delivery scenario.
 *
 * The scenario needs to be the receiver, not just the subscriber: the
 * signature, the Standard Webhooks headers, the verification challenge and the
 * retry behaviour are all only observable from the endpoint the server POSTs
 * to. So this runs a real HTTP server and records every request verbatim,
 * including the raw body bytes, because the signature is computed over those
 * and re-serializing the JSON would change them.
 *
 * Per-path behaviour lets one receiver serve every probe: a path that echoes
 * the challenge and accepts, one that redirects, one that refuses permanently,
 * and one that fails a few times before accepting.
 *
 * The receiver can also publish `/.well-known/mcp-webhook-receiver.json`, which
 * is the fourth way the document lets a server confirm intent: an origin that
 * serves it has declared consent for the path prefixes it names, and no
 * challenge POST is needed. `publishWellKnown` turns it on and `wellKnownFetches`
 * counts the GETs, which is how the scenario tells that path apart from a server
 * that simply skipped verification.
 *
 * Every path answers the verification challenge first, whatever its behaviour,
 * because a probe exists to misbehave on deliveries. A 410 probe that also
 * refused the challenge would never get subscribed by a server that verifies
 * inside events/subscribe, and its row would go untestable for a reason that
 * has nothing to do with 410. `wrong-challenge` is the one path that fails the
 * handshake, since that is its whole job.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedDelivery {
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The body exactly as it arrived, which is what the signature covers. */
  rawBody: string;
  /** Parsed body, when it was JSON. */
  json?: Record<string, unknown>;
  /** Milliseconds since the receiver started. */
  atMs: number;
  /** What this receiver answered. */
  respondedStatus: number;
}

export type PathBehaviour =
  | { kind: 'accept' }
  | { kind: 'redirect'; to: string }
  | { kind: 'gone' }
  | { kind: 'too-large' }
  | { kind: 'fail-then-accept'; failures: number; status: number }
  | { kind: 'wrong-challenge' };

/**
 * What the `wrong-challenge` path echoes instead of the nonce.
 *
 * Distinctive on purpose: the scenario looks for this string in whatever error
 * the server reports afterwards, because the document says a failed handshake
 * surfaces as a category and never as the endpoint's own response body.
 */
export const WRONG_CHALLENGE_ECHO = 'not-the-nonce';

/** Where a receiver declares which of its paths accept MCP deliveries. */
export const RECEIVER_WELL_KNOWN_PATH =
  '/.well-known/mcp-webhook-receiver.json';

export interface Receiver {
  /** Base URL of the receiver, e.g. `http://127.0.0.1:53211`. */
  readonly url: string;
  readonly deliveries: ReceivedDelivery[];
  /** Deliveries on one path, in arrival order. */
  on(path: string): ReceivedDelivery[];
  /** Set how a path answers. Unknown paths accept. */
  behave(path: string, behaviour: PathBehaviour): void;
  /**
   * Serve the well-known document, declaring `prefixes` as consenting paths.
   * Until this is called the path answers 404, which is what a receiver that
   * cannot publish same-origin content looks like.
   */
  publishWellKnown(prefixes: string[]): void;
  /** How many times the well-known document has been fetched. */
  wellKnownFetches(): number;
  /** Resolve once a delivery on `path` matches, or undefined at the deadline. */
  waitFor(
    path: string,
    predicate: (d: ReceivedDelivery) => boolean,
    timeoutMs: number
  ): Promise<ReceivedDelivery | undefined>;
  close(): Promise<void>;
}

export async function startReceiver(host = '127.0.0.1'): Promise<Receiver> {
  const deliveries: ReceivedDelivery[] = [];
  const behaviours = new Map<string, PathBehaviour>();
  const failureCounts = new Map<string, number>();
  const startedAt = Date.now();
  let wellKnown: string[] | undefined;
  let wellKnownGets = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      let json: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON, which is itself something the scenario grades.
      }

      // The well-known document is not a delivery, so it is answered before the
      // per-path behaviours and recorded only as a fetch count.
      if (path === RECEIVER_WELL_KNOWN_PATH) {
        if (!wellKnown) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        wellKnownGets += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ receivers: wellKnown }));
        return;
      }

      const behaviour = behaviours.get(path) ?? { kind: 'accept' };
      const respond = (status: number, body?: string): void => {
        deliveries.push({
          path,
          method: req.method ?? 'GET',
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [
              k.toLowerCase(),
              Array.isArray(v) ? v.join(', ') : (v ?? '')
            ])
          ),
          rawBody,
          json,
          atMs: Date.now() - startedAt,
          respondedStatus: status
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body ?? '{}');
      };

      const challenge = json?.challenge;
      const isChallenge =
        json?.type === 'verification' && typeof challenge === 'string';
      if (isChallenge && behaviour.kind !== 'wrong-challenge') {
        respond(200, JSON.stringify({ challenge }));
        return;
      }

      switch (behaviour.kind) {
        case 'redirect':
          res.writeHead(302, { location: behaviour.to });
          deliveries.push({
            path,
            method: req.method ?? 'GET',
            headers: {},
            rawBody,
            json,
            atMs: Date.now() - startedAt,
            respondedStatus: 302
          });
          res.end();
          return;
        case 'gone':
          respond(410);
          return;
        case 'too-large':
          respond(413);
          return;
        case 'wrong-challenge':
          respond(200, JSON.stringify({ challenge: WRONG_CHALLENGE_ECHO }));
          return;
        case 'fail-then-accept': {
          const seen = failureCounts.get(path) ?? 0;
          if (seen < behaviour.failures) {
            failureCounts.set(path, seen + 1);
            respond(behaviour.status);
            return;
          }
          break;
        }
        default:
          break;
      }

      // A challenge without the `type` discriminator: still echo it, so a
      // server that got the envelope shape slightly wrong is graded on the
      // row about the shape rather than locked out of every other row.
      if (typeof challenge === 'string') {
        respond(200, JSON.stringify({ challenge }));
        return;
      }
      respond(200);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    deliveries,
    on(path) {
      return deliveries.filter((d) => d.path === path);
    },
    behave(path, behaviour) {
      behaviours.set(path, behaviour);
    },
    publishWellKnown(prefixes) {
      wellKnown = prefixes;
    },
    wellKnownFetches() {
      return wellKnownGets;
    },
    async waitFor(path, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = deliveries.filter((d) => d.path === path).find(predicate);
        if (hit) return hit;
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
