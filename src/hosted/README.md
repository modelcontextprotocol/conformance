# Hosted conformance server

Runs the client-testing scenarios as a single long-lived HTTP server so a
client-under-test can point at a public URL instead of being spawned by the
runner.

```bash
npx @modelcontextprotocol/conformance hosted --port 3000
# behind a reverse proxy:
npx @modelcontextprotocol/conformance hosted --port 3000 --public-origin https://conformance.example.com
```

## Routes

| Route                                   | Purpose                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /`                                 | Landing page with usage + scenario list                                                           |
| `GET /scenarios`                        | JSON list of hostable scenarios                                                                   |
| `ALL /s/<scenario>/<run-id>[/<suffix>]` | MCP endpoint. Run is created lazily on first hit; pick any `[A-Za-z0-9_-]{1,64}` run-id.          |
| `GET /s/<scenario>`                     | Mints a fresh run-id and returns `{runId, mcpUrl, resultsUrl}`.                                   |
| `GET /results/<run-id>`                 | JSON `{scenario, summary, checks}`                                                                |
| `GET /results/<run-id>.html`            | Pretty HTML report                                                                                |
| `DELETE /results/<run-id>`              | Tear down the run early                                                                           |
| `POST /mcp`                             | The hosted server is itself an MCP server with `list_scenarios`, `start_run`, `get_results` tools |

## How it works

Each scenario implements `handler(): RequestListener` (see `HandlerScenario`
in `src/types.ts`). The hosted server instantiates a fresh scenario per
`(scenario, run-id)`, mounts its handler under `/s/<scenario>/<run-id>`, and
rewrites `req.url` to strip the prefix — **no loopback port, no proxy**. The
CLI runner's `start()`/`stop()` are now thin wrappers around the same
`handler()`, so both modes exercise identical code.

### Stateless transport

The run-id lives in the **URL path**, not the `mcp-session-id` header, so
correlation works for stateless-transport clients (every draft-spec scenario
that uses `sessionIdGenerator: undefined`). A client that never echoes a
session id still hits the same `/s/<scenario>/<run-id>` and its checks
accumulate on that run.

### Coverage

Hostable = any scenario that implements `handler()` (single origin) or
`authHandlers()` (multi-origin, see below). `listHostableScenarios()` derives
the list at runtime, gated by which aux origins are configured.

`sse-retry` implements `handler()` and works under `conformance hosted`, but
its connection-close-timing checks won't be meaningful through a buffered
fetch bridge — see below.

## Auth scenarios — second-origin relay

`auth/*` scenarios stand up two cross-referencing HTTP apps: a resource
server (the MCP endpoint + PRM) and an OAuth authorization server. The
`.well-known/*` discovery paths and RFC 8414 `issuer` validation are
**origin-rooted**, so the AS can't live under `/s/<scenario>/<id>/` — it
needs its own public origin.

```
client                    RS origin                      AS-relay origin
  │  POST /s/auth/.../mcp     │                              │
  │──────────────────────────▶│ 401 + WWW-Authenticate       │
  │  GET /.well-known/oauth-protected-resource/s/auth/...    │
  │──────────────────────────▶│ {authorization_servers:      │
  │                           │  [<as>/r/<id>]}              │
  │  GET /.well-known/oauth-authorization-server/r/<id>      │
  │──────────────────────────────────────────────────────────▶│
  │                           │◀── /__aux/as/.well-known/... │
  │                           │    (x-relay-secret)          │
```

The AS relay (`examples/hosted/valtown-relay.ts`) is **stateless** — it just
forwards every request to `<rs-origin>/__aux/<role><path>` with a shared
secret. All scenario state (closures, checks) stays on the RS process; the
per-run AS issuer is `<as-origin>/r/<run-id>` so the run-id is recoverable
from any path the client constructs from it. The RS app extracts that
`/r/<id>` segment, strips it, and dispatches to the run's AS handler with the
path `createAuthServer()` registered.

```bash
# CLI — also reads CONFORMANCE_RELAY_SECRET from env
npx @modelcontextprotocol/conformance hosted \
  --port 3000 \
  --as-origin https://conformance-as.example.com \
  --relay-secret "$(openssl rand -hex 32)"
```

Two extra routes appear when `--as-origin` is set:

| Route                                               | Purpose                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/s/<...>` | RFC 9728 root-level PRM dispatch — recovers run from the path suffix |
| `ALL /__aux/<role>/*`                               | Relay backchannel; 403 without `x-relay-secret`                      |

The three-origin scenarios (`authorization-server-migration` needs `--as2-origin`,
`enterprise-managed-authorization` needs `--idp-origin`) are mounted only
when those flags are set; deploy one more relay per role with
`CONFORMANCE_RELAY_ROLE=as2|idp`.

**Fidelity note:** the hosted AS issuer always carries a `/r/<id>` path
component, so scenarios that locally test root-issuer discovery
(`auth/metadata-default`, `auth/metadata-var1`) become path-issuer tests when
hosted. The RFC 8414 mechanics are identical.
`auth/2025-03-26-endpoint-fallback` (no-metadata fallback to `/authorize` at
the MCP origin) is not hostable.

## Serverless / val.town

`examples/hosted/valtown.ts` wraps `createHostedApp()` in a
`(Request) => Promise<Response>` bridge so the **same scenarios** run on
fetch-based runtimes (val.town, Deno Deploy, Bun, Workers with
`nodejs_compat`):

```ts
import handler from 'npm:@modelcontextprotocol/conformance/examples/hosted/valtown';
export default handler;
```

The bridge buffers the response, so streaming-SSE scenarios (`sse-retry`) are
returned as 501; everything else — including the SDK's
`StreamableHTTPServerTransport` in stateless mode — works.

### Two-val auth setup

| Val              | File                               | Env                                                                                      |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `conformance`    | `examples/hosted/valtown.ts`       | `CONFORMANCE_AS_ORIGIN=https://<you>-conformance-as.val.run`, `CONFORMANCE_RELAY_SECRET` |
| `conformance-as` | `examples/hosted/valtown-relay.ts` | `CONFORMANCE_RS_ORIGIN=https://<you>-conformance.val.run`, `CONFORMANCE_RELAY_SECRET`    |

Same `CONFORMANCE_RELAY_SECRET` on both. Run state lives in the RS val's
process memory, so a run must complete within one warm isolate (~minutes on
val.town — fine for a conformance flow).

## Example

```bash
# pick any run-id; results live at the matching path
$ npx @modelcontextprotocol/inspector https://conformance.example.com/s/tools_call/demo/mcp
$ curl https://conformance.example.com/results/demo | jq .summary
{ "passed": 1, "failed": 0, "warnings": 0, "info": 4, "skipped": 0, "total": 5 }
```

Or drive it over MCP: connect to `/mcp`, call `start_run` → run client →
`get_results`.
