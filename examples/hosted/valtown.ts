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

import { createHostedApp } from '../../src/hosted/server';
import { toFetchHandler } from './fetch-bridge';

const NOT_FETCH_SAFE = new Set(['sse-retry']);

// Auth scenarios need a second public origin (RFC 8414 well-known is
// origin-rooted). Deploy examples/hosted/valtown-relay.ts as a separate val
// and point CONFORMANCE_AS_ORIGIN at it; both vals share
// CONFORMANCE_RELAY_SECRET so /__aux can't be hit directly.
const { app } = createHostedApp({
  auxOrigins: {
    as: process.env.CONFORMANCE_AS_ORIGIN,
    as2: process.env.CONFORMANCE_AS2_ORIGIN,
    idp: process.env.CONFORMANCE_IDP_ORIGIN
  },
  relaySecret: process.env.CONFORMANCE_RELAY_SECRET
});

const bridge = toFetchHandler(app);

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

  return bridge(request);
}
