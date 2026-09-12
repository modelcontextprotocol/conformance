# Hosted conformance server

Runs the client-testing scenarios as a single long-lived HTTP server so a
client-under-test can point at a public URL instead of being spawned by the
runner.

```bash
npx @modelcontextprotocol/conformance hosted --port 3000
# behind a reverse proxy:
npx @modelcontextprotocol/conformance hosted --port 3000 --public-origin https://conformance.example.com
```

## The matrix

One run exercises the whole matrix: every registered client scenario (rows)
at every specification revision that ships a requirement set in
`requirements/` (columns — today `2025-11-25` and `2026-07-28`). A **cell**
is one scenario at one revision; its id `<run-id>/<revision>/<scenario>` is
the URL path the client is pointed at, the store key and the results path.

Each cell carries two independent facts:

- **scoring** — what the revision's `requirements/<rev>.yaml` makes of the
  scenario: `scored` (in its `client:` list), `not_scored` (listed but never
  counted, with the yaml's reason), `unlisted` (applies to the revision but
  the frozen set predates it) or `n/a` (does not apply: introduced later,
  removed earlier, or an extension the set does not carry). `n/a` cells are
  never mounted.
- **startable** — whether this deployment can mount it: the scenario has
  been converted to `handler()` / `authHandlers()`, every relay origin it
  needs is configured, and the deployment has not excluded it
  (`HostedServerOptions.exclude`). A cell that cannot start answers 501 with
  the reason.

Each cell speaks its column's wire: the `2025-11-25` column serves the
stateful mock (initialize handshake), the `2026-07-28` column the stateless
one (per-request `_meta`, `MCP-Protocol-Version` on every request) — exactly
what `conformance client --spec-version <rev>` would run.

## Routes

| Route                                         | Purpose                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /`                                       | Landing page: the static matrix (scoring, startability, steps)                                   |
| `GET /scenarios`                              | JSON rows with a cell per revision                                                               |
| `GET /s`                                      | Mints a run id, `303 → /s/<run-id>`                                                              |
| `GET /s/<run-id>`                             | Config for every startable cell of the run                                                       |
| `GET /s/<run-id>/<rev>`                       | Config for one column                                                                            |
| `GET /s/<run-id>/<rev>/<scenario>`            | Config for one cell (a page request, see below)                                                  |
| `ALL /s/<run-id>/<rev>/<scenario>[/<suffix>]` | The cell's server. The MCP endpoint is the cell URL plus `/mcp`, for every scenario (see below). |
| `GET /results/<run-id>`                       | Verdict per cell, `scored X of N` per column, client identity                                    |
| `GET /results/<run-id>/<rev>`                 | One column                                                                                       |
| `GET /results/<run-id>/<rev>/<scenario>`      | One cell: `{runId, revision, scenario, scoring, verdict, summary, checks}` (see below)           |
| `DELETE /results/<run-id>`                    | Tear down every cell of the run                                                                  |

Run ids match `[A-Za-z0-9_-]{1,64}`; pick your own or take the minted one.
Cells are created lazily on first request. Scenario names may contain `/`
and sit at the end of the path, so they are resolved by longest registered
name (`auth/metadata-var2/tenant1` → scenario `auth/metadata-var2`, suffix
`/tenant1`).

**Every cell's MCP URL ends in `/mcp`.** Scenarios that serve MCP at their
handler root (`mcpPath` `''`) are reached at `<cell>/mcp` as well: the
server rewrites that suffix to `/` before dispatch (and
`/.well-known/oauth-protected-resource/s/<cell>/mcp` to the bare well-known
path), so the config, the matrix pages and `/scenarios` show one URL shape.

**Cell results** answer 200 for every cell of the matrix, exercised or not:
`verdict` is `incomplete` with a zero `summary` and empty `checks` for a
cell nobody has hit (plus `startable: false, startReason` for one this
deployment cannot start) and `n/a` with the `reason` for a scenario that
does not apply to the revision. Only an unknown revision or scenario is
a 404.

**Representation.** Config and results answer HTML when the request prefers
`text/html` and JSON otherwise; `?format=html|json` overrides. At a cell URL
a GET that accepts `text/html` (and not `text/event-stream`) or carries
`?format=` is a page/config request; every other request — POST, an SSE GET,
DELETE, well-known paths — is dispatched to the scenario. Dispatched
responses carry `link: <…/results/<run-id>/<rev>/<scenario>>;
rel="conformance-results"`.

**Config JSON** (run, column or cell scope):

```json
{
  "runId": "…", "revision": "2026-07-28", "scenario": "tools_call",
  "resultsUrl": "…/results/<run-id>/2026-07-28/tools_call",
  "mcpServers": { "2026-07-28/tools_call": { "type": "http", "url": "…/s/<run-id>/2026-07-28/tools_call/mcp" } },
  "cells": [{
    "scenario": "tools_call", "revision": "2026-07-28", "url": "…", "resultsUrl": "…",
    "scoring": "scored", "steps": [{ "op": "tools/list" }, …],
    "env": {
      "MCP_CONFORMANCE_SCENARIO": "tools_call",
      "MCP_CONFORMANCE_PROTOCOL_VERSION": "2026-07-28",
      "MCP_CONFORMANCE_CONTEXT": "{\"name\":\"tools_call\",\"steps\":[…]}"
    }
  }]
}
```

`env` is what the CLI runner would set for the client under test; `context`
is the scenario's context (credentials, `steps`) tagged with `name`, as a
JSON string. The HTML pages have copy-to-clipboard buttons for the same data.

**Report.** A cell's verdict is `pass` (checks recorded, no FAILURE), `fail`
(any FAILURE), `incomplete` (never hit, or hit but nothing recorded) or
`n/a`. Per column, `scored: { passed, total, startable }` counts passes
among every cell the revision's requirement set scores — `total` is the
yaml's count whether or not this deployment can start the cell, `startable`
how many of those it can (the HTML says "3 of 32 scored (11 startable
here)"); `not_scored`/`unlisted` results are listed next to the score, never
inside it. The header names each client once — by `clientInfo` name and
version — with every protocol version it negotiated, read off accepted
exchanges only: on the stateful wire the `initialize` params and the
`protocolVersion` the server answered with, on the stateless wire
`_meta['io.modelcontextprotocol/clientInfo']` and the accepted request's
`MCP-Protocol-Version` header. Recorded as an INFO check
`hosted-client-identity` on the cell with `details.protocolVersions`.

The hosted layer also records two FAILUREs of its own about requests to a
cell's MCP endpoint, so a cell cannot read green when the wire turned every
request away (`src/hosted/wire.ts`):

- `hosted-wire-rejected` — a 4xx whose body is a lifecycle rejection
  (JSON-RPC `-32020`/`-32022`, `-32602` naming `_meta`, or `-32000`
  "Unsupported protocol version"); once per distinct (code, message). An
  unsupported-version rejection of a request whose header already names
  the cell's revision is a scenario's deliberate probe (`request-metadata`
  rejects a run's first request once), not a wire rejection.
- `hosted-wrong-revision` — the client spoke a revision other than the
  cell's: on the `2026-07-28` column any request whose `MCP-Protocol-Version`
  is not the column's, or any `initialize`; on a dated column any
  post-`initialize` request whose header names another revision
  (`initialize` itself negotiates and is exempt); once per distinct
  (method, header version). On a dated column a foreign-revision request
  the wire turned away (a 4xx lifecycle rejection, or `-32601` for a
  method the dated wire lacks) is version negotiation — a dual-era client
  probes with `server/discover` at `2026-07-28`, then falls back to
  `initialize` — and records neither check; one the wire accepted is
  still a wrong revision.

Both decide the verdict like any FAILURE. The `auth/*` resource server
records the same rejection in the scenario's own log as
`stateless-request-rejected`.

## How it works

Each scenario implements `handler(): RequestListener` (see `HandlerScenario`
in `src/types.ts`). The hosted server instantiates a fresh scenario per cell
with a `ScenarioContext` for the column's revision, mounts its handler under
`/s/<run-id>/<rev>/<scenario>`, and rewrites `req.url` to strip the prefix —
**no loopback port, no proxy**. The CLI runner's `start()`/`stop()` are thin
wrappers around the same `handler()`, so both modes exercise identical code.

The run id lives in the **URL path**, not the `mcp-session-id` header, so
correlation works for stateless-transport clients: a client that never
echoes a session id still hits the same cell and its checks accumulate there.

Each cell gets its own scenario instance, built from the registry entry with
a no-arg constructor. A scenario whose constructor takes parameters (one
class registered under several names, e.g. `skills/verification-*`)
implements `Scenario.fresh()` to carry them into the per-cell copy.

The hosted layer reads JSON request bodies without consuming them
(`src/hosted/body.ts` intercepts the parser's `push()`), so the client
identity can be recorded while the scenario still reads the stream itself.

## Auth scenarios — second-origin relay

`auth/*` scenarios stand up two cross-referencing HTTP apps: a resource
server (the MCP endpoint + PRM) and an OAuth authorization server. The
`.well-known/*` discovery paths and RFC 8414 `issuer` validation are
**origin-rooted**, so the AS can't live under the cell prefix — it needs its
own public origin.

```
client                    RS origin                             AS-relay origin
  │  POST /s/<cell>/mcp        │                                     │
  │───────────────────────────▶│ 401 + WWW-Authenticate              │
  │  GET /.well-known/oauth-protected-resource/s/<cell>/mcp          │
  │───────────────────────────▶│ {authorization_servers:             │
  │                            │  [<as>/r/<cell>]}                   │
  │  GET /.well-known/oauth-authorization-server/r/<cell>            │
  │─────────────────────────────────────────────────────────────────▶│
  │                            │◀── /__aux/as/.well-known/…/r/<cell> │
  │                            │    (x-relay-secret)                 │
```

The AS relay (`examples/hosted/valtown-relay.ts`) is **stateless** — it just
forwards every request to `<rs-origin>/__aux/<role><path>` with a shared
secret. All scenario state (closures, checks) stays on the RS process; the
per-cell AS issuer is `<as-origin>/r/<run-id>/<rev>/<scenario>` so the cell
is recoverable from any path the client constructs from it. The RS app
locates that `/r/<cell>` segment run, strips it, and dispatches to the cell's
AS handler with the path `createAuthServer()` registered. A cell is rebuilt
from its id alone when a process has never seen it, so an AS request that
arrives before the RS was ever hit still lands.

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
| `GET /.well-known/oauth-protected-resource/s/<...>` | RFC 9728 root-level PRM dispatch — recovers the cell from the suffix |
| `ALL /__aux/<role>/*`                               | Relay backchannel; 403 without `x-relay-secret`                      |

Scenarios needing `as2`/`idp` origins become startable when `--as2-origin` /
`--idp-origin` are set; deploy one more relay per role with
`CONFORMANCE_RELAY_ROLE=as2|idp`. (No registered scenario has been converted
to `authHandlers()` with those roles yet.)

**Fidelity note:** the hosted AS issuer always carries a `/r/<cell>` path
component, so scenarios that locally test root-issuer discovery
(`auth/metadata-default`, `auth/metadata-var1`) become path-issuer tests when
hosted. The RFC 8414 mechanics are identical.

## Serverless / val.town

`examples/hosted/valtown.ts` wraps `createHostedApp()` in a
`(Request) => Promise<Response>` bridge so the **same scenarios** run on
fetch-based runtimes (val.town, Deno Deploy, Bun, Workers with
`nodejs_compat`). Deploy with `examples/hosted/deploy-valtown.ts`; the vals
are listed in `examples/hosted/valtown-manifest.json`.

val.town spreads one run's requests over several isolates that share no
memory, so `valtown.ts` excludes the scenarios whose checks depend on one
process seeing consecutive requests (`sse-retry`, `auth/metadata-var2`,
`elicitation-sep1034-client-defaults`, `sep-2322-client-request-state`); the
matrix shows them as not startable with that reason. Everything else
persists its raw check log to the account's SQLite (`RunStore`,
`examples/hosted/valtown-store.ts`) and `/results` re-judges the merged log.

An isolate that has never seen a cell is **hydrated** before it dispatches
its first request to it: the scenario's `checks` array is seeded with the
merged log the store holds for the cell (`SessionManager.acquire`), so a
scenario that keys its behaviour on its own log — `request-metadata` rejects
the run's first request exactly once — sees the run's history rather than
just this isolate's. Seeded checks are persisted by the isolate that wrote
them; an isolate's row holds only what it recorded or rewrote itself.

### Two-val auth setup

| Val     | File                               | Env                                                                                                           |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rs`    | `examples/hosted/valtown.ts`       | `CONFORMANCE_AS_ORIGIN=https://<relay val>.web.val.run`, `CONFORMANCE_RELAY_SECRET`                           |
| `relay` | `examples/hosted/valtown-relay.ts` | `CONFORMANCE_RS_ORIGIN=https://<rs val>.web.val.run`, `CONFORMANCE_RELAY_SECRET`, `CONFORMANCE_RELAY_ROLE=as` |

Same `CONFORMANCE_RELAY_SECRET` on both.

## Example

```bash
$ RUN=$(curl -sI https://conformance.example.com/s | sed -n 's#^location: /s/##Ip' | tr -d '\r')
$ npx @modelcontextprotocol/inspector https://conformance.example.com/s/$RUN/2025-11-25/tools_call/mcp
$ curl https://conformance.example.com/results/$RUN/2025-11-25/tools_call | jq .summary
{ "passed": 1, "failed": 0, "warnings": 0, "info": 5, "skipped": 0, "total": 6 }
$ curl https://conformance.example.com/results/$RUN | jq '.columns[] | {revision, scored}'
```
