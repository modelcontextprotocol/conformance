/**
 * Minimal HTTP proxy that forwards an incoming express request to a
 * scenario's loopback server and streams the response back.
 *
 * We don't use http-proxy-middleware to keep the dependency surface small
 * and because we need to inject/rewrite the mcp-session-id header.
 */

import http from 'http';
import { Request, Response } from 'express';
import { HostedSession } from './session';

/** Header used to correlate a client with its hosted session. */
export const SESSION_HEADER = 'mcp-session-id';

export function proxyToSession(
  session: HostedSession,
  req: Request,
  res: Response,
  /** Path on the target to hit. Defaults to the scenario's serverUrl path. */
  targetPath?: string
): void {
  const target = session.targetUrl;
  const path = targetPath ?? (target.pathname || '/');

  // Forward most headers but drop hop-by-hop ones and host (loopback target).
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'connection' || k === 'content-length') continue;
    headers[k] = v;
  }
  // Some scenarios assign their own mcp-session-id; let theirs flow back, but
  // make sure the client always sees ours so /results/<id> works.
  headers[SESSION_HEADER] = req.header(SESSION_HEADER) ?? session.id;

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path,
      method: req.method,
      headers
    },
    (upRes) => {
      const outHeaders = { ...upRes.headers };
      // Always advertise our session id so the client can fetch results,
      // regardless of what the scenario set.
      outHeaders[SESSION_HEADER] = session.id;
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: `Upstream scenario error: ${err.message}`
        }
      });
    } else {
      res.end();
    }
  });

  // Stream the body. express.json() may have already consumed it; if so,
  // re-serialize. Otherwise pipe raw (covers SSE GETs / DELETEs / unparsed).
  if (req.body !== undefined && Object.keys(req.body).length > 0) {
    const body = JSON.stringify(req.body);
    upstream.setHeader('content-length', Buffer.byteLength(body));
    upstream.end(body);
  } else if (req.readable) {
    req.pipe(upstream);
  } else {
    upstream.end();
  }
}
