/**
 * MCP conformance — auxiliary-origin relay (val.town).
 *
 * The hosted RS app owns all scenario state, but auth scenarios need a second
 * public origin so OAuth `.well-known/*` discovery and issuer validation work
 * (those are origin-rooted by RFC 8414/9728 — they can't live under the
 * `/s/<scenario>/<run-id>/` prefix). This val IS that origin: it forwards
 * every request to the RS app's `/__aux/<role>/*` backchannel and adds a
 * shared secret so the backchannel can't be spoofed by hitting the RS
 * directly.
 *
 * One val per role: deploy this once for `as`, and again for `as2` / `idp`
 * if you need the three-origin scenarios (authorization-server-migration,
 * enterprise-managed-authorization).
 *
 * val.town env (Project → Settings → Environment variables):
 *   CONFORMANCE_RS_ORIGIN     https://<rs-val>.val.run
 *   CONFORMANCE_RELAY_SECRET  <random ≥32 bytes; same on RS val>
 *   CONFORMANCE_RELAY_ROLE    as | as2 | idp   (default: as)
 *
 * Deploy: create an HTTP val and paste:
 *
 *   import handler from "https://esm.sh/@modelcontextprotocol/conformance/examples/hosted/valtown-relay.ts";
 *   export default handler;
 *
 * No scenario logic lives here, so you only redeploy this when the relay
 * contract changes — adding/editing scenarios only touches the RS val.
 */

declare const process: { env: Record<string, string | undefined> };

const RS_ORIGIN = process.env.CONFORMANCE_RS_ORIGIN;
const RELAY_SECRET = process.env.CONFORMANCE_RELAY_SECRET;
const ROLE = process.env.CONFORMANCE_RELAY_ROLE ?? 'as';

/**
 * Headers we forward from the client. Everything else is dropped so a client
 * can't smuggle x-relay-secret / x-forwarded-* through us, and so the
 * upstream sees a stable shape regardless of what the edge added.
 */
const FORWARD_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'content-length',
  'user-agent'
] as const;

export default async function handler(req: Request): Promise<Response> {
  if (!RS_ORIGIN || !RELAY_SECRET) {
    return Response.json(
      {
        error:
          'relay misconfigured: set CONFORMANCE_RS_ORIGIN and CONFORMANCE_RELAY_SECRET'
      },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const target = `${RS_ORIGIN}/__aux/${ROLE}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('x-relay-secret', RELAY_SECRET);
  // The aux handler reconstructs absolute URLs (issuer, endpoints) from
  // getAuxBaseUrl() which the RS app already knows, so it doesn't strictly
  // need this — but it's useful for logging/debugging on the RS side.
  headers.set('x-relay-host', url.host);

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await req.arrayBuffer(),
    // /authorize 302s to the client's redirect_uri — pass it through, don't
    // follow it ourselves.
    redirect: 'manual'
  });

  // Strip hop-by-hop / origin-identifying headers; pass everything else.
  const outHeaders = new Headers(upstream.headers);
  for (const h of ['content-encoding', 'transfer-encoding', 'connection']) {
    outHeaders.delete(h);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders
  });
}
