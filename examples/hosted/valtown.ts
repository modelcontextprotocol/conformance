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
import { registerRequirementSources } from '../../src/requirements';
import { toFetchHandler } from './fetch-bridge';
import { SqliteRunStore } from './valtown-store';
import { REQUIREMENT_SOURCES } from './requirements-bundle';

// Imports have been evaluated by the time this runs; see withServerTiming.
const MODULE_EVALUATED_AT = performance.now();

// The deploy stages the TypeScript import closure only, so requirements/*.yaml
// is not on the val. The matrix's columns come from the bundled copies
// (regenerate with `npm run hosted:bundle-requirements`); this must run
// before createHostedApp(), which builds the matrix at construction.
registerRequirementSources(REQUIREMENT_SOURCES);

/**
 * val.town spreads one run's requests over several isolates that share no
 * memory, and cannot route a request to the isolate holding another one
 * open. These scenarios cannot be served there; the matrix shows each as
 * not startable with its reason, written for the client developer reading
 * the page. (MRTR carries its cross-request state inside the requestState
 * it sends, and the SEP-2352 migration scenario reads the run's latest log
 * before every request, so both run here.)
 */
const EXCLUDE: Record<string, string> = {
  'sse-retry':
    'its reconnect test keeps a response stream open and times the reconnect across requests, and Val Town can send those requests to different server instances that share no memory',
  'elicitation-sep1034-client-defaults':
    "keeps the tool call's response open on one server instance while it waits for your client's answer to an elicitation request, and that answer arrives as a separate request that Val Town cannot guarantee reaches the same instance"
};

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

/**
 * Runs `handle`, then awaits `flush`, and reports where the time went in a
 * standard Server-Timing header so a slow response can be attributed from
 * the client side (`curl -si ... | grep -i server-timing`):
 *
 *   cold  — only on the isolate's first request: ms from module evaluation
 *           to its arrival (app construction plus dispatch)
 *   boot  — same request only: ms from the runtime's time origin to module
 *           evaluation (isolate start plus imports)
 *   app   — the bridge and hosted app
 *   flush — the awaited store write
 *
 * Status, headers and body pass through unchanged; the body stays a stream.
 */
export function withServerTiming(
  handle: (request: Request) => Promise<Response>,
  flush: () => Promise<unknown>,
  evaluatedAt: number,
  now: () => number = () => performance.now()
): (request: Request) => Promise<Response> {
  let served = false;
  const ms = (n: number) => Math.round(n * 10) / 10;
  return async (request) => {
    const arrived = now();
    const first = !served;
    served = true;
    const response = await handle(request);
    const handled = now();
    await flush();
    const flushed = now();
    const metrics = [
      `app;dur=${ms(handled - arrived)}`,
      `flush;dur=${ms(flushed - handled)}`
    ];
    if (first) {
      metrics.unshift(
        `cold;desc="first request in isolate";dur=${ms(arrived - evaluatedAt)}`,
        `boot;desc="time origin to module evaluation";dur=${ms(evaluatedAt)}`
      );
    }
    // A Response's headers may be immutable, so build a new one around the
    // same (unread) body rather than appending in place.
    const headers = new Headers(response.headers);
    headers.append('server-timing', metrics.join(', '));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  };
}

// The bridge buffers until end(), by which point the scenario has recorded
// its checks and the write-through has started; finish it before the
// isolate is allowed to go idle. val.town has no waitUntil, and a promise
// still running after the response may be stopped with the isolate, so
// the record is not left to one. The write is one store round trip: a
// cell's rows go together, and a discover does not wait on seeding.
export default withServerTiming(
  toFetchHandler(app),
  () => sessions.flush(),
  MODULE_EVALUATED_AT
);
