/**
 * In-process replay of a client's request to another cell's listener.
 *
 * A composite cell answers some requests from several child cells at once
 * (`tools/list` has to list every child's tools), so it sends each child a
 * copy of the client's request and merges the answers. The copy goes through
 * the same dispatch() as a real request, so the child judges and records it
 * exactly as if the client had sent it there.
 *
 * The copy is a fresh IncomingMessage carrying the client's method, headers
 * and (already buffered) body; the response captures status, headers and
 * body instead of writing to a socket — the approach of
 * examples/hosted/fetch-bridge.ts.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import type { Request, Response } from 'express';
import { BUFFERED_BODY } from './body';

export interface Replayed {
  status: number;
  contentType?: string;
  body: string;
}

/** A child that never finishes its answer must not hang the client's request. */
const REPLAY_TIMEOUT_MS = 10_000;

export function replay(
  original: Request,
  body: Buffer,
  send: (req: Request, res: Response) => void,
  timeoutMs: number = REPLAY_TIMEOUT_MS
): Promise<Replayed> {
  // Express's req.protocol reads socket.encrypted, and IncomingMessage's
  // _destroy calls socket.destroy(), so an unconnected Socket is simplest.
  const socket = Object.assign(new Socket(), { encrypted: false });
  const req = new IncomingMessage(socket);
  req.method = original.method;
  req.url = original.url;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.headers = { ...original.headers, 'content-length': String(body.length) };
  // @hono/node-server (the SDK transport's Node→Web step) reads rawHeaders.
  Object.defineProperty(req, 'rawHeaders', {
    value: Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.flatMap((x) => [k, x]) : [k, String(v)]
    ),
    writable: true,
    configurable: true
  });
  req.push(body);
  req.push(null);
  (req as unknown as Record<symbol, Buffer>)[BUFFERED_BODY] = body;
  // The few express accessors dispatch() and origin() read.
  const header = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v;
  };
  Object.assign(req, {
    header,
    get: header,
    protocol: original.protocol,
    query: original.query
  });

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  let status = 200;
  const put = (k: string, v: unknown) =>
    headers.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  const collect = (c: unknown, encoding?: unknown) => {
    if (c === undefined || c === null || typeof c === 'function') return;
    chunks.push(
      Buffer.isBuffer(c)
        ? c
        : c instanceof Uint8Array
          ? Buffer.from(c)
          : Buffer.from(
              String(c),
              typeof encoding === 'string'
                ? (encoding as BufferEncoding)
                : 'utf8'
            )
    );
  };
  res.setHeader = ((k: string, v: unknown) => {
    put(k, v);
    return res;
  }) as ServerResponse['setHeader'];
  res.getHeader = (k: string) => headers.get(k.toLowerCase());
  res.removeHeader = (k: string) => {
    headers.delete(k.toLowerCase());
  };
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code;
    for (const r of rest) {
      if (typeof r === 'object' && r !== null) {
        for (const [k, v] of Object.entries(r)) put(k, v);
      }
    }
    return res;
  }) as ServerResponse['writeHead'];
  res.write = ((c: unknown, encoding?: unknown) => {
    collect(c, encoding);
    return true;
  }) as ServerResponse['write'];
  res.flushHeaders = () => {};
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (v: number) => {
      status = v;
    }
  });

  return new Promise<Replayed>((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: 504, body: '' }),
      timeoutMs
    );
    res.end = ((c?: unknown, encoding?: unknown) => {
      collect(c, encoding);
      clearTimeout(timer);
      resolve({
        status,
        contentType: headers.get('content-type'),
        body: Buffer.concat(chunks).toString('utf8')
      });
      return res;
    }) as ServerResponse['end'];
    send(req as unknown as Request, res as unknown as Response);
  });
}
