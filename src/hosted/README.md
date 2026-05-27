# Hosted conformance server

Runs the client-testing scenarios as a single long-lived HTTP server so a
client-under-test can point at a public URL instead of being spawned by the
runner.

```bash
npx @modelcontextprotocol/conformance hosted --port 3000
# or with a public origin behind a proxy:
npx @modelcontextprotocol/conformance hosted --port 3000 --public-origin https://conformance.example.com
```

## Routes

| Route                          | Purpose                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                        | Landing page with usage + scenario list                                                                                                                                                       |
| `GET /scenarios`               | JSON list of hostable scenarios                                                                                                                                                               |
| `ALL /s/<scenario>[/<suffix>]` | MCP endpoint for `<scenario>`. First request without `mcp-session-id` creates a session; the response carries `mcp-session-id` and a `Link: </results/ID>; rel="conformance-results"` header. |
| `GET /results/<id>`            | JSON `{summary, checks}`                                                                                                                                                                      |
| `GET /results/<id>.html`       | Pretty HTML report                                                                                                                                                                            |
| `DELETE /results/<id>`         | Tear down the session early                                                                                                                                                                   |
| `POST /mcp`                    | The hosted server is itself an MCP server with `list_scenarios`, `start_session`, `get_results` tools                                                                                         |

## How it works

Each session is a real `Scenario` instance started on a loopback port; the
hosted server proxies `/s/<name>` to it and overlays the session id. That
means every scenario works **unchanged** as long as it only needs one origin.

Excluded (`auth/*`): scenarios that spin up a separate authorization server
on a second port. The proxy can't expose two origins, and OAuth discovery
metadata hard-codes absolute URLs. Run those with the CLI runner.

Sessions are reaped after `--ttl` ms idle (default 5 min).

## val.town

`examples/hosted/valtown.ts` is a self-contained fetch-handler version with
the same URL shape but no loopback proxy — scenarios are reimplemented as
`Request → Response` functions. It ships with `initialize` and `tools_call`;
add more entries to its `scenarios` map as needed.

## Example

```bash
# 1. point your client at the scenario URL
$ my-mcp-client https://conformance.example.com/s/tools_call

# 2. read mcp-session-id from any response header, then:
$ curl https://conformance.example.com/results/TJeZ63Bw | jq .summary
{ "passed": 1, "failed": 0, "warnings": 0, "info": 4, "skipped": 0, "total": 5 }
```

Or drive the whole flow over MCP by connecting to `/mcp` and calling
`start_session` → run client → `get_results`.
