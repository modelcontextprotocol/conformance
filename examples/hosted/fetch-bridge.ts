/**
 * Web fetch ↔ Node bridge: adapt a Node RequestListener (express app) to a
 * fetch-style handler for serverless runtimes (val.town, Deno Deploy, Bun).
 *
 * Intercepts the user-facing write surface (writeHead/setHeader/write/end)
 * so we never touch ServerResponse's socket-coupled internals — the approach
 * serverless-http and light-my-request take.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

type NodeListener = (req: IncomingMessage, res: ServerResponse) => void;

export function toFetchHandler(
  listener: NodeListener
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // --- web Request → Node IncomingMessage ---
    const body = request.body
      ? Buffer.from(await request.arrayBuffer())
      : undefined;
    // Express's req.protocol/req.ip read socket.encrypted/.remoteAddress,
    // and IncomingMessage._destroy calls socket.destroy(), so a real
    // (unconnected) Socket with the encrypted flag patched on is the path
    // of least surprise.
    const socket = Object.assign(new Socket(), { encrypted: false });
    const nodeReq = new IncomingMessage(socket);
    nodeReq.method = request.method;
    nodeReq.url = url.pathname + url.search;
    nodeReq.httpVersion = '1.1';
    nodeReq.httpVersionMajor = 1;
    nodeReq.httpVersionMinor = 1;
    nodeReq.headers = Object.fromEntries(request.headers);
    nodeReq.headers.host ??= url.host;
    if (body?.length) nodeReq.headers['content-length'] = String(body.length);
    // The SDK's StreamableHTTPServerTransport converts Node→Web via
    // @hono/node-server, which reads rawHeaders (the [k,v,k,v,...] array),
    // not the parsed headers object. Deno's node:http compat exposes
    // rawHeaders as a getter-only accessor, so shadow it with an own
    // property instead of assigning.
    Object.defineProperty(nodeReq, 'rawHeaders', {
      value: Object.entries(nodeReq.headers).flat() as string[],
      writable: true,
      configurable: true
    });
    if (body?.length) nodeReq.push(body);
    nodeReq.push(null);

    // --- Node ServerResponse → web Response ---
    const nodeRes = new ServerResponse(nodeReq);
    const chunks: Buffer[] = [];
    let status = 200;
    const headers = new Headers();

    const captureHeaders = (
      h?: Record<string, string | string[] | number>
    ) => {
      for (const [k, v] of Object.entries(h ?? {})) {
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
    };
    nodeRes.setHeader = ((k: string, v: string | string[] | number) => {
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      return nodeRes;
    }) as ServerResponse['setHeader'];
    nodeRes.getHeader = (k: string) =>
      headers.get(k.toLowerCase()) ?? undefined;
    nodeRes.removeHeader = (k: string) => headers.delete(k);
    nodeRes.writeHead = ((code: number, h?: Record<string, string>) => {
      status = code;
      captureHeaders(h);
      return nodeRes;
    }) as ServerResponse['writeHead'];
    nodeRes.write = ((c: string | Buffer, enc?: BufferEncoding) => {
      if (c) chunks.push(typeof c === 'string' ? Buffer.from(c, enc) : c);
      return true;
    }) as ServerResponse['write'];
    nodeRes.flushHeaders = () => {};
    Object.defineProperty(nodeRes, 'statusCode', {
      get: () => status,
      set: (v: number) => {
        status = v;
      }
    });

    return new Promise<Response>((resolve) => {
      nodeRes.end = ((c?: string | Buffer, enc?: BufferEncoding) => {
        if (c) chunks.push(typeof c === 'string' ? Buffer.from(c, enc) : c);
        resolve(
          new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status,
            headers
          })
        );
        return nodeRes;
      }) as ServerResponse['end'];

      listener(nodeReq, nodeRes);
    });
  };
}
