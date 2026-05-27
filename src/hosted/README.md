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

Hostable = any scenario that implements `handler()`. Currently that's
everything **except** `auth/*` (need a second public origin for the
authorization server). `listHostableScenarios()` derives the list at runtime
from which scenarios expose `handler()`.

`sse-retry` implements `handler()` and works under `conformance hosted`, but
its connection-close-timing checks won't be meaningful through a buffered
fetch bridge — see below.

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

## Example

```bash
# pick any run-id; results live at the matching path
$ npx @modelcontextprotocol/inspector https://conformance.example.com/s/tools_call/demo/mcp
$ curl https://conformance.example.com/results/demo | jq .summary
{ "passed": 1, "failed": 0, "warnings": 0, "info": 4, "skipped": 0, "total": 5 }
```

Or drive it over MCP: connect to `/mcp`, call `start_run` → run client →
`get_results`.
