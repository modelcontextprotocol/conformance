# Running the SEP-2640 skills scenarios against an implementation

Three server scenarios, brand-neutral: they discover everything dynamically and
hardcode no fixture URIs, so pointing them at a new server is a URL change.

```bash
npx @modelcontextprotocol/conformance server --url <SERVER_URL> \
  --scenario sep-2640-skills-enumeration
```

(or `npm start -- server ...` from a checkout of this repo).

Repeat for `sep-2640-skills-manifest` and `sep-2640-skills-directory`.

## The two flags, and why both

`--force` is only needed together with `--spec-version`. Extension scenarios
sit outside the spec timeline, so an explicit `--spec-version` does not select
them and they SKIP as "not applicable" unless `--force` is passed as well.
Without `--spec-version` they run on the draft wire and need no `--force`.

`--spec-version` selects the **wire lifecycle**, not just a filter. The default
is the stateless draft wire, which asserts `MCP-Protocol-Version: 2026-07-28`
with no handshake. Against a server that does not speak that version you get:

```
-32022: protocol version "2026-07-28" is not supported by this server
```

which reads like a missing method and is not. Add `--spec-version 2025-11-25 --force`
to use the stateful wire instead. The scenarios are version-portable: only
`ttlMs` / `cacheScope` are gated on 2026-07-28 and later, and that check
reports SKIPPED below the floor rather than failing.

## Reading the totals

Each scenario's total includes the framework's `wire-schema-valid`, so
subtract one per scenario for SEP-2640 check IDs. SKIPPED rows are not
failures: `directoryRead` is an optional capability, and a server that does
not declare it correctly skips all six directory checks.

## Verified runs

| Implementation           | Invocation                            | Result                          |
| ------------------------ | ------------------------------------- | ------------------------------- |
| mcpkit `ext/skills`      | default                               | 32 / 6 / 7 = **45**, 0 failures |
| go-sdk (PRs 1238 + 1240) | stateless handler, default flags      | 30 / 6 / 7 = **43**, 0 failures |
| go-sdk (PRs 1238 + 1240) | stateful, `--spec-version 2025-11-25` | 29 / 6 / 7 = **42**, 0 failures |
| csharp-sdk (PR 1856)     | `/stateless`, default flags           | 30 / 6 / 1 = **37**, 0 failures |
| csharp-sdk (PR 1856)     | `/`, `--spec-version 2025-11-25`      | 29 / 6 / 1 = **36**, 0 failures |

All runs 2026-09-07. The C# directory column is 1 because that SDK does not
declare `directoryRead`, which is optional.

## Per-implementation setup

**go-sdk.** A minimal `skills.AddDirectory(server, dir, nil)` server is enough.
The streamable transport serves 2026-07-28 and later **only** when built with
`&mcp.StreamableHTTPOptions{Stateless: true}`, because SEP-2575 defines that as
the sessionless wire. A stateful handler negotiates a 2026-07-28 request down
to 2025-11-25, which is correct rather than a defect.

**csharp-sdk.** The repo ships its own harness, so no fixture is needed:

```bash
dotnet build tests/ModelContextProtocol.ConformanceServer
dotnet run --project tests/ModelContextProtocol.ConformanceServer --framework net10.0
```

It serves the stateful lifecycle at `/` and the SEP-2575 stateless lifecycle at
`/stateless` off one port, so both rows above come from a single process. Note
it takes its port from `launchSettings.json` (3001 by default) and ignores
`ASPNETCORE_URLS` when run with `--no-build`. `GET /health` returns `Healthy`
once it is up.

**mcpkit.** `examples/skills` serves the fixture used above:

```bash
cd examples/skills && go build -o skills-demo .
./skills-demo --serve --addr=:18099 --skills=$PWD/skills
```
