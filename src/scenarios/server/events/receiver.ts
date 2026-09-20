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

export interface Receiver {
  /** Base URL of the receiver, e.g. `http://127.0.0.1:53211`. */
  readonly url: string;
  readonly deliveries: ReceivedDelivery[];
  /** Deliveries on one path, in arrival order. */
  on(path: string): ReceivedDelivery[];
  /** Set how a path answers. Unknown paths accept. */
  behave(path: string, behaviour: PathBehaviour): void;
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
          respond(200, JSON.stringify({ challenge: 'not-the-nonce' }));
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

      // The verification handshake: prove intent by echoing the nonce.
      const challenge = json?.challenge;
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
