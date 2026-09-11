/**
 * MCP conformance — val.town deployment.
 *
 * The hosted runner mounts each scenario's `handler()` (a Node
 * `RequestListener`) under `/s/<run-id>/<revision>/<scenario>`. On val.town
 * the entry point is a fetch handler, so we bridge web Request→Node req/res
 * once and reuse the *real* scenario implementations from the package — no
 * reimplementation, no loopback port.
 *
 * Deploy with examples/hosted/deploy-valtown.ts, or create an HTTP val and
 * paste:
 *
 *   import handler from "https://esm.sh/@modelcontextprotocol/conformance/examples/hosted/valtown.ts";
 *   export default handler;
 *
 * Requires a runtime with Node-compat (`node:http`, `node:stream`) —
 * val.town, Deno Deploy, Bun all qualify.
 */

import { createHostedApp } from '../../src/hosted/server';
import { toFetchHandler } from './fetch-bridge';
import { SqliteRunStore } from './valtown-store';

/**
 * val.town spreads one run's requests over several isolates that share no
 * memory. Scenarios whose checks depend on one process seeing consecutive
 * requests (SSE reconnect timing, tenant-prefixed AS state, elicitation
 * round-trips, MRTR request state) cannot be judged there; the matrix shows
 * them as not startable with this reason.
 */
const SINGLE_PROCESS_ONLY =
  "needs a single-process host (Val Town isolates don't share in-memory state)";
const EXCLUDE = Object.fromEntries(
  [
    'sse-retry',
    'auth/metadata-var2',
    'elicitation-sep1034-client-defaults',
    'sep-2322-client-request-state'
  ].map((name) => [name, SINGLE_PROCESS_ONLY])
);

// Auth scenarios need a second public origin (RFC 8414 well-known is
// origin-rooted). Deploy examples/hosted/valtown-relay.ts as a separate val
// and point CONFORMANCE_AS_ORIGIN at it; both vals share
// CONFORMANCE_RELAY_SECRET so /__aux can't be hit directly.
const { app, sessions } = createHostedApp({
  auxOrigins: {
    as: process.env.CONFORMANCE_AS_ORIGIN,
    as2: process.env.CONFORMANCE_AS2_ORIGIN,
    idp: process.env.CONFORMANCE_IDP_ORIGIN
  },
  relaySecret: process.env.CONFORMANCE_RELAY_SECRET,
  // val.town spreads one run's requests over several isolates; persist to
  // the account's SQLite so /results is the union of what they all saw.
  store: process.env.valtown ? new SqliteRunStore() : undefined,
  exclude: EXCLUDE
});

const bridge = toFetchHandler(app);

export default async function (request: Request): Promise<Response> {
  const response = await bridge(request);
  // The bridge buffers until end(), by which point the scenario has recorded
  // its checks and the write-through has started; finish it before the
  // isolate is allowed to go idle.
  await sessions.flush();
  return response;
}
