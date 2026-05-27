/**
 * MCP conformance — val.town deployment.
 *
 * The hosted runner mounts each scenario's `handler()` (a Node
 * `RequestListener`) under `/s/<scenario>/<run-id>`. On val.town the entry
 * point is a fetch handler, so we bridge web Request→Node req/res once and
 * reuse the *real* scenario implementations from the package — no
 * reimplementation, no loopback port.
 *
 * Deploy: create an HTTP val and paste:
 *
 *   import handler from "https://esm.sh/@modelcontextprotocol/conformance/examples/hosted/valtown.ts";
 *   export default handler;
 *
 * or copy this file in directly. Requires a runtime with Node-compat
 * (`node:http`, `node:stream`) — val.town, Deno Deploy, Bun all qualify.
 *
 * Limitation: scenarios that rely on long-lived SSE streams or connection-
 * close timing (`sse-retry`) won't behave correctly through a buffered
 * Request→Response bridge. They're filtered out below.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHostedApp } from '../../src/hosted/server';

const NOT_FETCH_SAFE = new Set(['sse-retry']);

const { app } = createHostedApp();

export default async function (request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Short-circuit scenarios that need true streaming.
  const m = url.pathname.match(/^\/s\/([^/]+)/);
  if (m && NOT_FETCH_SAFE.has(m[1])) {
    return Response.json(
      {
        error: `scenario '${m[1]}' relies on SSE stream lifecycle and is not available via the fetch bridge`
      },
      { status: 501 }
    );
  }

  // --- web Request → Node IncomingMessage ---
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  // Express's req.protocol/req.ip read socket.encrypted/.remoteAddress, and
  // IncomingMessage._destroy calls socket.destroy(), so a real (unconnected)
  // Socket with the encrypted flag patched on is the path of least surprise.
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
  // not the parsed headers object.
  nodeReq.rawHeaders = Object.entries(nodeReq.headers).flat() as string[];
  if (body?.length) nodeReq.push(body);
  nodeReq.push(null);

  // --- Node ServerResponse → web Response ---
  // Intercept the user-facing write surface (writeHead/setHeader/write/end)
  // so we never touch ServerResponse's socket-coupled internals. This is the
  // approach serverless-http and light-my-request take.
  const nodeRes = new ServerResponse(nodeReq);
  const chunks: Buffer[] = [];
  let status = 200;
  const headers = new Headers();

  const captureHeaders = (h?: Record<string, string | string[] | number>) => {
    for (const [k, v] of Object.entries(h ?? {})) {
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
  };
  nodeRes.setHeader = ((k: string, v: string | string[] | number) => {
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return nodeRes;
  }) as ServerResponse['setHeader'];
  nodeRes.getHeader = (k: string) => headers.get(k.toLowerCase()) ?? undefined;
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

    app(nodeReq, nodeRes);
  });
}
