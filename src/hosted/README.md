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
| `GET /results/<run-id>/<rev>/<scenario>`      | One cell: `{runId, revision, scenario, scoring, verdict, state, summary, checks}` (see below)    |
| `GET /results/<run-id>[/<rev>]?format=md`     | The run report as Markdown, for an issue or a chat                                               |
| `POST /results/<run-id>/freeze`               | Freeze the run's report: `201 {snapshotId, url, markdownUrl}`, or `303` to it for a browser      |
| `GET /results/<run-id>/snapshot/<id>`         | A frozen report (HTML, JSON or `?format=md`); later traffic never changes it                     |
| `DELETE /results/<run-id>`                    | Tear down every cell of the run, and its snapshots                                               |

Run ids match `[A-Za-z0-9_-]{1,64}`; pick your own or take the minted one.
Minted ids are ten characters of lower-case Crockford base32 (no `i`, `l`,
`o` or `u`), so one read off a screenshot cannot be misread.
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
a 404. Reading results never changes them: every view judges a copy of the
cell's log, so a page left open or reloaded cannot turn a verdict, and a
cell that only a config page created stays empty until a client hits it.

**Representation.** Config and results answer HTML when the request prefers
`text/html` and JSON otherwise; `?format=html|json` overrides. At a cell URL
a GET that accepts `text/html` (and not `text/event-stream`) or carries
`?format=` is a page/config request; every other request — POST, an SSE GET,
DELETE, well-known paths — is dispatched to the scenario. Dispatched
responses carry `link: <…/results/<run-id>/<rev>/<scenario>>;
rel="conformance-results"`.

A browser opening a cell's (or composite's) MCP URL itself is redirected to
its page. A GET for an event stream on an MCP endpoint whose scenario serves
none there (most do not; `sse-retry` and the `http-*-headers` scenarios do)
answers 405 with `Allow: POST` and the SDK transport's JSON-RPC error rather
than an HTML 404, and records the INFO check `hosted-get-on-mcp-path` —
clients send one to open a stream, and VS Code sends one after a 400 as its
fallback to the old HTTP+SSE transport.

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
is the scenario's context (credentials, tool arguments such as
`http-custom-headers`' `toolCalls`, `steps`) tagged with `name`, as a JSON
string. The HTML pages have copy-to-clipboard buttons for the same data, and
show each step as a plain line a person can make a hand-driven client follow
("call add*numbers with a=5 and b=3"), with the JSON beside it. Every cell
and composite also has a button that copies the bare MCP URL, and ready-to-paste
config for VS Code (`servers` in `.vscode/mcp.json`), Codex
(`[mcp_servers.<name>]` with `url` in `~/.codex/config.toml`), Goose (an
`extensions:` entry of `type: streamable_http` with `uri` in
`~/.config/goose/config.yaml`) and the `mcpServers` JSON other clients read,
each with its own copy button. Names are `c9e-<revision>-<scenario>` with
anything but letters, digits, `*`and`-`made`-`
(`c9e-2025-11-25-auth-metadata-default`); the run page's ready-made
composites are `c9e-<revision>-composite`. The run page's blocks cover the
ready-made composites and every auth cell, one paste per client
(`src/hosted/client-config.ts`). An `auth/\*`cell, which has no generic-client steps, shows plain ones for a hand-driven
client (connect, approve the sign-in, list the tools) and any`client_id`/`client_secret`the scenario gives the client as copyable fields;`request-metadata`and`http-standard-headers` say what a person should
expect. The little markdown in scenario descriptions is rendered.

**Report.** A cell's verdict is `pass` (checks recorded, no FAILURE), `fail`
(any FAILURE), `incomplete` (never hit, or hit but nothing recorded) or
`n/a`. An `incomplete` cell may still list FAILUREs: they are the scenario's
expectations that nothing has met yet ("Tool was not called by client"), not
a verdict, and its `note` says so in plain words — "nothing recorded yet",
"the client has not yet done anything this scenario tests; the 5 failures
listed are what it is still waiting for", or, for a client that only ever
sent the legacy handshake to a `2026-07-28` cell, "the client spoke
2025-11-25 only (it opened with initialize) and did not retry at
2026-07-28". The HTML leads each failed check with its reason (its
`errorMessage`, or `details.message`), with the check's id, name and
description underneath.

A cell's results (page, JSON and the counts in the run report) show one row
per check: a check recorded again with the same id, description and
`details.method` — the protected-resource metadata fetched on every retry —
is one row with `repeats`, kept by the expected-failures collapse rule (the
worst, ties to the latest). A FAILURE the scenario reports before it has
seen anything, such as a step of the auth flow the client never reached, is
marked `notSeen` with the reason "the flow did not reach this step" (or the
scenario's own words, "Tool was not called by client") and counted in
`summary.notSeen`, apart from the client's `failed`. Every FAILURE, WARNING
and SKIPPED row carries a one-line `reason`, and no row carries `details:
null`. None of this changes a check's status or a verdict. Per column, `scored: { passed, total, startable }` counts passes
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

**Run report.** The run and column reports are meant to be linked, so a
person can see how a client did without opening each cell. Every cell has a
`state` next to its verdict, which splits `incomplete` three ways:
`not-tried` (no request reached it), `in-progress` (the client reached it
but nothing its scenario tests has happened yet) and `incomplete` (the
client reached it and stopped short: it opened with a legacy `initialize`
and never retried at the cell's revision), and splits `fail` off as
`waiting` when every failure is not seen — nothing the client did is wrong,
the flow has not finished (a consent screen, an elicitation form still to
answer); its note says "waiting for the client or the person to finish the
flow", and its verdict stays `fail` until the steps happen. The others are
`pass`, `fail`, `not-startable` and `n/a`. Each column counts its cells per state. A cell
the client reached lists its FAILUREs and WARNINGs as `findings`, one line
each (`errorMessage`, else `details.message`, else the check's description,
plus any `expectedX`/`actualX` pair or `stopReason` in its details), marked
`by: "client"` when it was seen in the client's traffic, or `by:
"scenario"` when it is what the scenario reports having seen nothing at
all: an expectation not yet met, such as "Tool was not called by client".
The report's `causes` say each finding once with the cells it covers. A
client that speaks only an older revision, and so is stopped by every
`2026-07-28` cell it reaches, is one cause, with the era errors it drew
there folded in. The HTML page shows the causes, then a row per reached
cell with its failures inline, then the full matrix. None of this changes a
check, a verdict or a score (`src/hosted/findings.ts`).

`?format=md` gives the same report as Markdown: the client, the score, the
causes and a table of only the cells the client reached, each failure
marked `client` or `not seen`. The page has a button that copies it.
`?format=text` gives the same as plain lines, one bullet per reached cell,
for a chat that shows a Markdown table as raw pipes (Slack); the page's
"copy for Slack" button copies that.
Anything taken from traffic is escaped so it cannot open a link, a tag or a
new table cell.

**Snapshots.** `POST /results/<run-id>/freeze` (the page's "freeze a copy to
link to" button) stores the whole run's report as it stands, in the run
store, and answers with its permalink `/results/<run-id>/snapshot/<id>`.
The copy never changes as more traffic arrives, so it can be cited in an
issue; its cell links open the live results. A snapshot is plain JSON in
the store with no protection beyond the run id, like the rest of a run. On
val.town snapshots are kept for 30 days
(`CONFORMANCE_SNAPSHOT_RETENTION_MS`); a single process without a store
keeps them in memory.

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
  is not the column's; on a dated column any post-`initialize` request whose
  header names another revision (`initialize` itself negotiates and is
  exempt); once per distinct (method, header version). On a dated column a
  modern probe is not a wrong revision (see below); a foreign-revision
  request the cell accepted, or one in the dated shape whose header names
  another revision, is.

A request that is both — the wrong revision, and turned away for it — is one
mistake and records one check: `hosted-wrong-revision`, with the rejection in
its message and in `details.rejected`. `hosted-wire-rejected` is left for a
client that spoke the cell's revision and was still turned away (a missing
`_meta`, say).

An `initialize` on the `2026-07-28` column is neither. A client may open with
the legacy handshake to learn the server's era, and a modern-only server
answers it with an error naming its versions, after which the client retries
with one of them (2026-07-28 `basic/versioning`, "Backward Compatibility with
Initialization-Based Versions"). Every cell of the column, composites
included, gives the same answer — HTTP 400 with JSON-RPC `-32022`
"Unsupported protocol version" and `data: {supported: ["2026-07-28"],
requested}` — and the hosted layer sends it before the scenario sees the
request, so a scenario whose bundled server would complete the handshake
(`json-schema-ref-no-deref`, which the CLI runner's SDK clients still open
that way) cannot accept it here. An `auth/*` cell answers 401 first, as a
protected server must, and its resource server gives the same `-32022` after
sign-in. The hosted layer records the probe as the INFO check
`hosted-legacy-probe`, once per header version, with the version asked for in
`details.requestedVersion` and the answer in `details.rejected`. It never
decides the verdict: a client that probes and then speaks `2026-07-28` is
judged on what it sent next, and one that never does leaves the cell
`incomplete`, not green.

The mirror case on a dated column is a modern probe: a dual-era client opens
with `server/discover` (or any request) at `2026-07-28`, the cell turns it
away, and the client falls back to `initialize` at the cell's revision. It may
do so on every connect, so whether a request is a probe is read
from the request alone, never from what the cell answered before it or which
process saw it:

- a `server/discover` is always a probe, however often and whenever it comes;
- any other request in the `2026-07-28` shape (per-request `_meta` naming a
  newer revision) is a probe when the cell turned it away (a 4xx, including
  the 401 an `auth/*` cell answers before it looks at the protocol).

Every dated cell, composites included, answers `server/discover` the same
way before the scenario sees it: HTTP 400 with JSON-RPC `-32000` "Bad Request:
Unsupported protocol version: … (supported versions: <revision>)", what the
`2025-11-25` SDK transport answers. On HTTP that is how a server without
`2026-07-28` support turns a modern request away: a 4xx whose body is not a
recognized modern error, so the client falls back (2026-07-28
`basic/transports/streamable-http`, "Backward Compatibility"); a 404 with
`-32601` is what a modern server says of a method it lacks, and a client may
take it for one. An `auth/*` cell answers 401 first, and its resource server
gives the same 400 after sign-in. The hosted layer records a probe as the
INFO check `hosted-modern-probe`, once per revision probed for, with the
method in `details.method` and the answer in `details.rejected`; a probe first
met with 401 and repeated after sign-in reports the version answer it drew
then. A request in the dated shape (no per-request `_meta`) whose header names
another revision is the client carrying on at the wrong revision
(`hosted-wrong-revision`, any rejection folded in), and so is a
foreign-revision request the cell accepted.

A POST to a cell's MCP endpoint whose body is empty or not JSON gets HTTP 400
with a plain JSON-RPC `-32700` "Parse error" on every cell and composite (the
bundled servers quoted their parser's exception), and the INFO check
`hosted-unparseable-body`. It is neither a probe nor a wrong revision.

A dated cell tests exactly its column's revision, so its `initialize` answer
always states it: the bundled servers would echo an older version they
support (`2025-06-18`) and the cell would then fail the client for speaking
it. The hosted layer rewrites the `protocolVersion` of an accepted
`initialize` result to the cell's revision (the CLI runner still sees the
scenario's own answer), and when the client asked for another version
records the INFO check `hosted-version-offered` with
`details.requestedVersion` and `details.answeredVersion`, so a client that
declines or goes quiet is explained. One that carries on at the version it
asked for is a wrong revision. The initialize scenario's
`mcp-client-initialization` check says the same: on a hosted cell its
`details.versionMatch` is whether the client asked for the cell's revision.

A cell passes only once the client has spoken its revision there: an accepted
request at it (an `initialize` asking for it, or a request whose
`MCP-Protocol-Version` names it). A cell whose checks would otherwise pass
without one — an OAuth flow completed by a client that then spoke only an
older revision, say — is `incomplete`, with the INFO check
`hosted-revision-not-spoken` saying why. A scenario that expects the client to
stop before it reaches the MCP endpoint (it must reject a bad issuer, say) is
judged on its own checks as before.

Both decide the verdict like any FAILURE. The `auth/*` resource server
records the same rejection in the scenario's own log as
`stateless-request-rejected`, except a rejected `initialize`, which it notes
as the INFO check `stateless-legacy-probe` for the same reason.

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
`CONFORMANCE_RELAY_ROLE=as2|idp`. `auth/authorization-server-migration` is
the one converted scenario that needs `as2`; none needs `idp` yet.

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
`auth/authorization-server-migration`, `elicitation-sep1034-client-defaults`);
the matrix shows them as not startable with that reason.
`sep-2322-client-request-state` (MRTR) runs here: the only state its retry
needs, the original request id and the exact `requestState`, travels inside
the `requestState` it sends, with a digest so any isolate can rebuild and
compare it byte for byte. Everything else
persists its raw check log to the account's SQLite (`RunStore`,
`examples/hosted/valtown-store.ts`) and `/results` re-judges the merged log.

An isolate that has never seen a cell is **hydrated** before it dispatches
its first request to it: the scenario's `checks` array is seeded with the
merged log the store holds for the cell (`SessionManager.acquire`), so a
scenario that keys its behaviour on its own log — `request-metadata` rejects
the run's first request exactly once — sees the run's history rather than
just this isolate's. Seeded checks are persisted by the isolate that wrote
them; an isolate's row holds only what it recorded or rewrote itself.

A `server/discover` is the exception: a client may give it about a second
before it falls back to an older handshake (the GitHub Copilot runtime
does), so it is answered without waiting on the store, on a single cell and
on a composite alike. The dated cells' refusal is the hosted layer's own,
and a 2026-07-28 scenario's answer does not depend on its log unless it sets
`discoverReadsHistory` (`request-metadata` does: its one rejection can fall
on a discover), in which case the cell is seeded first as before. Auth cells
are always seeded first. The discover is still recorded: an isolate writes
its rows for a cell together (`SessionManager.persist`), skipping rows that
have not changed, so `valtown.ts` — which flushes before it answers, so that
no write is left to an isolate that may be stopped — waits one store round
trip for a discover, rather than one per row after seeding.

Auth scenarios keep nothing only in memory between two requests. The PKCE
challenge and requested scopes ride in the authorization code, the granted
scopes ride in the access token (in plain text: test tokens are fixtures,
not credentials, and an implementation that edits its own tokens only
misleads its own report), and a verdict that spans requests (which
authorization request came first, whether the client went on to the token
endpoint) is read from the log when the log is judged, not counted as the
requests arrive. Hydration happens once per cell per isolate, so an
isolate's copy of the log can lag behind the run: a scenario that must
consult the latest log to decide how to answer a request cannot be hosted
here. `auth/authorization-server-migration` is one — its PRM switches
authorization servers once a token has been accepted, and an isolate whose
copy predates that keeps sending the client to the first server.
`auth/scope-retry-limit` also answers from its copy of the log — it stops a
client with a 410 after three token-bearing requests — but only to bound a
client that never stops by itself. Its verdict counts the authorization
attempts in the merged log, so across isolates a client with no retry limit
is stopped later (up to three 403s per isolate) and still fails, and one that
limits itself never reaches the cut-off. `src/hosted/hosted-auth.test.ts`
drives every hostable auth scenario through two processes sharing a store to
hold the rest to this, and a client with no retry limit through both.

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
