/**
 * Non-consuming capture of JSON request bodies.
 *
 * The hosted layer wants to read what the client under test sent (its
 * `initialize` params or per-request `_meta`) without taking the body away
 * from the scenario, whose listener reads the stream itself (express.json(),
 * raw `data` events, the SDK's Node→Web conversion). Consuming and replaying
 * would need a second IncomingMessage and change 'close' semantics, so
 * instead we intercept `push()` — the parser's entry point into the
 * Readable — and copy each chunk as it arrives. Flow control, listeners and
 * consumption are untouched.
 *
 * Fetch-style bridges (examples/hosted/fetch-bridge.ts) already hold the
 * whole body before the listener runs; they publish it under BUFFERED_BODY
 * and the tap is skipped.
 */

import type { IncomingMessage } from 'http';
import type { RequestHandler } from 'express';

/** Set by a bridge that has the complete body up front. */
export const BUFFERED_BODY = Symbol.for('mcp-conformance.hosted.bufferedBody');
const TAP = Symbol.for('mcp-conformance.hosted.bodyTap');

/** Bodies above this are not captured (the identity we look for is small). */
export const BODY_CAP = 256 * 1024;

interface Tap {
  body: Buffer | undefined;
  done: boolean;
  waiters: Array<(body: Buffer | undefined) => void>;
}

type Tapped = IncomingMessage & {
  [BUFFERED_BODY]?: Buffer;
  [TAP]?: Tap;
};

function isJsonPost(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false;
  const type = req.headers['content-type'] ?? '';
  return /^application\/json\b/i.test(type);
}

/** Express middleware: start capturing JSON POST bodies as they flow in. */
export function tapJsonBody(): RequestHandler {
  return (req, _res, next) => {
    if (isJsonPost(req)) installTap(req);
    next();
  };
}

export function installTap(req: IncomingMessage): void {
  const r = req as Tapped;
  if (r[BUFFERED_BODY] !== undefined || r[TAP] !== undefined) return;
  const tap: Tap = { body: undefined, done: false, waiters: [] };
  r[TAP] = tap;
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const push = r.push.bind(r);
  r.push = ((chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk === null) {
      tap.done = true;
      tap.body = overflow ? undefined : Buffer.concat(chunks);
      for (const w of tap.waiters.splice(0)) w(tap.body);
    } else if (!overflow) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), encoding);
      size += buf.length;
      if (size > BODY_CAP) overflow = true;
      else chunks.push(buf);
    }
    return push(chunk as Buffer | null, encoding);
  }) as IncomingMessage['push'];
}

/**
 * Call `cb` with the request body once it is complete — immediately when it
 * already is (bridged requests, or a body that arrived with the headers) —
 * or never, if the body was not captured (not a JSON POST, over the cap, or
 * the client never finished sending it).
 */
export function onBody(req: IncomingMessage, cb: (body: Buffer) => void): void {
  const r = req as Tapped;
  if (r[BUFFERED_BODY] !== undefined) {
    if (isJsonPost(req)) cb(r[BUFFERED_BODY]);
    return;
  }
  const tap = r[TAP];
  if (!tap) return;
  const deliver = (body: Buffer | undefined) => {
    if (body !== undefined) cb(body);
  };
  if (tap.done) deliver(tap.body);
  else tap.waiters.push(deliver);
}
