# MCP Conformance Test Framework

A framework for testing MCP (Model Context Protocol) client and server implementations against the specification.

**For SDK maintainers:** See [SDK Integration Guide](./SDK_INTEGRATION.md) for a streamlined guide on integrating conformance tests into your SDK repository.

## Quick Start

### Testing Clients

```bash
# Using the everything-client (recommended)
npx @modelcontextprotocol/conformance client --command "tsx examples/clients/typescript/everything-client.ts" --scenario initialize

# Run an entire suite of tests
npx @modelcontextprotocol/conformance client --command "tsx examples/clients/typescript/everything-client.ts" --suite auth
```

### Testing Servers

```bash
# Run all server scenarios (default)
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp

# Run a single scenario
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --scenario server-initialize
```

### List Available Scenarios

```bash
npx @modelcontextprotocol/conformance list
```

## Overview

The conformance test framework validates MCP implementations by:

**For Clients:**

1. Starting a test server for the specified scenario
2. Running the client implementation with the test server URL
3. Capturing MCP protocol interactions
4. Running conformance checks against the specification
5. Generating detailed test results

**For Servers:**

1. Connecting to the running server as an MCP client
2. Sending test requests and capturing responses
3. Running conformance checks against server behavior
4. Generating detailed test results

## Usage

### Client Testing

```bash
npx @modelcontextprotocol/conformance client --command "<client-command>" --scenario <scenario-name> [options]
```

**Options:**

- `--command` - The command to run your MCP client (can include flags)
- `--scenario` - The test scenario to run (e.g., "initialize")
- `--suite` - Run a suite of tests in parallel: `all`, `core`, `extensions`, `backcompat`, `auth`, `metadata`, `draft` (scenarios targeting the in-progress draft spec), or `sep-835`
- `--spec-version <version>` - Filter scenarios by spec version (e.g., `2025-11-25`, `2026-07-28`; `draft` is accepted as an alias for the current draft identifier). The draft version selects the latest dated release plus any draft-only scenarios. When omitted, the version is inferred from the scenario's spec applicability (draft-only scenarios run at the draft version, everything else at the latest dated release); an explicitly requested version outside a scenario's applicability window skips the scenario (exit 0) unless `--force` is passed
- `--force` - Run a scenario even if it is not applicable at the requested `--spec-version`
- `--requirements <revision>` - Run exactly what a spec revision requires, frozen at its release (see [Conformance Requirements](#conformance-requirements))
- `--expected-failures <path>` - Path to YAML baseline file of known failures (see [Expected Failures](#expected-failures))
- `--timeout` - Timeout in milliseconds (default: 30000)
- `--verbose` - Show verbose output

The framework appends `<server-url>` as an argument to your command and sets the `MCP_CONFORMANCE_SCENARIO` environment variable to the scenario name. For scenarios that require additional context (e.g., client credentials), the `MCP_CONFORMANCE_CONTEXT` environment variable contains a JSON object with scenario-specific data. When `--spec-version` is passed, its resolved value is forwarded to the client process as `MCP_CONFORMANCE_PROTOCOL_VERSION`; example clients can use this value directly as their `protocolVersion`. SDKs that hard-code their protocol version can ignore it. Clients under test must derive the lifecycle from the protocol version they are asked to run: dated versions through `2025-11-25` use the stateful lifecycle (initialize handshake), while the 2026 draft (`2026-07-28`) uses the stateless lifecycle (per-request `_meta`).

### Server Testing

```bash
npx @modelcontextprotocol/conformance server --url <url> [--scenario <scenario>]
```

**Options:**

- `--url` - URL of the server to test
- `--scenario <scenario>` - Test scenario to run (e.g., "server-initialize"). Runs all available scenarios by default
- `--suite <suite>` - Suite to run: "active" (default; excludes pending and draft-spec scenarios), "all", "draft" (scenarios targeting the in-progress draft spec), or "pending"
- `--requirements <revision>` - Run exactly what a spec revision requires, frozen at its release (see [Conformance Requirements](#conformance-requirements))
- `--expected-failures <path>` - Path to YAML baseline file of known failures (see [Expected Failures](#expected-failures))
- `--verbose` - Show verbose output

## Test Results

**Client Testing** - Results are saved to `results/<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status
- `stdout.txt` - Client stdout output
- `stderr.txt` - Client stderr output

**Server Testing** - Results are saved to `results/server-<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status

### Wire-schema checks

Every scenario also validates each JSON-RPC message on the wire against the
spec's JSON schema for the negotiated spec version, and emits up to two
synthetic checks alongside the scenario's own:

- `wire-schema-valid` - fails when a message _the implementation under test
  sent_ violates the spec JSON schema. The failure details include every
  violating message and its schema errors.
- `wire-schema-harness-error` - fails when the _harness itself_ sent an
  invalid message. This indicates a bug in the conformance suite (or a
  deliberately nonconformant fixture), not in the implementation under test;
  please report it.

Scenarios that exchange no instrumented wire traffic (see issue #418) emit
neither check. Like any other check, `wire-schema-valid` can be baselined via
the expected-failures file.

## Conformance Requirements

`--suite` and `--spec-version` describe the suite as it is today. Neither answers
"which scenarios did I need to pass to conform to the spec released on
2026-07-28", because the suite keeps growing: a scenario merged after a revision
ships still carries that revision's applicability tag, so it is
indistinguishable from one that existed at release.

A requirement set answers that question. Each `requirements/<revision>.yaml`
names the scenarios a revision requires, for the two roles the specification
defines: an MCP server acting as an OAuth resource server, and an MCP client
acting as an OAuth client. It deliberately covers no authorization-server
scenarios, because the specification puts authorization server implementation
beyond its own scope, so those scenarios serve people deploying an authorization
server rather than implementations of MCP itself.

**Scenarios run at their revision's wire version.** That is the point of a
per-revision set, not a label on it: the dated revisions through `2025-11-25`
use the stateful initialize handshake and `2026-07-28` is stateless with
per-request `_meta`, and a scenario emits different checks under each. A
scenario belonging to both revisions must therefore be run twice, once under
each set. Passing it on one wire says nothing about the other:

```bash
# what does conforming to 2026-07-28 actually require?
npx @modelcontextprotocol/conformance list --requirements 2026-07-28

# run exactly that
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --requirements 2026-07-28
```

`--requirements` replaces `--suite`, `--spec-version` and `--scenario`, since the
set already names every scenario that runs and the revision fixes the wire they
run at. Without it nothing changes: the default is still to run everything, which
is where completeness lives.

`tier-check` takes several at once, and every one of them must pass for Tier 1:

```bash
npx @modelcontextprotocol/conformance tier-check --repo <owner/repo> \
  --conformance-server-url http://localhost:3000/mcp \
  --requirements 2025-11-25,2026-07-28
```

Only scenarios a revision actually requires decide the exit code and the pass
rate. Anything run without being scored is reported separately and cannot fail
the run.

Requirement sets are frozen, and `not_scored` holds what a revision runs and
reports without counting. Two reasons qualify, and the report names which
applies:

| Reason                | Meaning                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension`           | Optional by definition. SEP-1730: "Experimental features and protocol extensions (such as Tasks and MCP Apps) are not required for any tier." |
| `added-after-release` | The scenario did not exist when the revision shipped, so no implementation could have been passing it.                                        |

Both still run, so a failing extension stays visible in the report; neither moves
the pass rate. Promoting an entry into the required lists is a deliberate,
reviewable change, which is how the suite grows without retroactively failing
anyone.

This is the project's contract and lives in this repository. It is the opposite
of an [expected-failures](#expected-failures) baseline, which lives in an
implementation's own repository and records what that implementation knows it
fails. A baselined failure is still a failure against a requirement set.

## Expected Failures

SDKs that don't yet pass all conformance tests can specify a baseline of known failures. This allows running conformance tests in CI without failing, while still catching regressions.

Create a YAML file listing expected failures by mode:

```yaml
# conformance-baseline.yml
server:
  - tools-call-with-progress
  - resources-subscribe
client:
  - sse-retry
```

Then pass it to the CLI:

```bash
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --expected-failures ./conformance-baseline.yml
```

**Exit code behavior:**

| Scenario Result | In Baseline? | Outcome                                   |
| --------------- | ------------ | ----------------------------------------- |
| Fails           | Yes          | Exit 0 — expected failure                 |
| Fails           | No           | Exit 1 — unexpected regression            |
| Passes          | Yes          | Exit 1 — stale baseline, remove the entry |
| Passes          | No           | Exit 0 — normal pass                      |

This ensures:

- CI passes when only known failures occur
- CI fails on new regressions (unexpected failures)
- CI fails when a fix lands but the baseline isn't updated (stale entries)

### Baselining a single check

A scenario is many checks — `server-stateless` alone is over twenty — so baselining the
whole scenario to excuse one of them stops enforcing the other nineteen. An entry can
instead name a single check, as `<scenario>:<check-id>`:

```yaml
server:
  - tasks-lifecycle # whole scenario may fail
  - server-stateless:sep-2575-server-implements-discover # only this check may fail
```

The check id is the left-hand column the runner already prints for each check, so it can
be copied straight out of a failing run.

With a per-check entry, every failing check in that scenario is judged on its own: the
named one is excused, and any other failure is still an unexpected regression. The four
exit-code rules above apply per check rather than per scenario, with one addition — a
baselined check that is absent or skipped is tolerated, because a scenario that bails on
a failed prerequisite legitimately never reaches its later checks, and the prerequisite
reports its own failure anyway.

Two things to know:

- **A check id addresses every occurrence of that id.** Ids repeat within a run (a loop,
  a retried flow), and the occurrences collapse to one verdict, most-severe first. So
  baselining a repeated id excuses all of its occurrences — coarser than ideal, still far
  narrower than baselining the scenario.
- **Mind the space.** `- scenario:check-id` is a string; `- scenario: check-id` is YAML
  for a mapping and is rejected with an error.

A scenario cannot be listed both wholesale and per-check — the wholesale entry already
excuses everything, so the pair is contradictory and is rejected.

## GitHub Action

This repo provides a composite GitHub Action so SDK repos don't need to write their own conformance scripts.

### Server Testing

```yaml
steps:
  - uses: actions/checkout@v4

  # Start your server (SDK-specific)
  - run: |
      my-server --port 3001 &
      timeout 15 bash -c 'until curl -s http://localhost:3001/mcp; do sleep 0.5; done'

  - uses: modelcontextprotocol/conformance@v0.1.11
    with:
      mode: server
      url: http://localhost:3001/mcp
      expected-failures: ./conformance-baseline.yml # optional
```

### Client Testing

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: modelcontextprotocol/conformance@v0.1.11
    with:
      mode: client
      command: 'python tests/conformance/client.py'
      expected-failures: ./conformance-baseline.yml # optional
```

### Action Inputs

| Input               | Required    | Description                                     |
| ------------------- | ----------- | ----------------------------------------------- |
| `mode`              | Yes         | `server` or `client`                            |
| `url`               | Server mode | URL of the server to test                       |
| `command`           | Client mode | Command to run the client under test            |
| `expected-failures` | No          | Path to YAML baseline file                      |
| `suite`             | No          | Test suite to run                               |
| `scenario`          | No          | Run a single scenario by name                   |
| `timeout`           | No          | Timeout in ms for client tests (default: 30000) |
| `verbose`           | No          | Show verbose output (default: false)            |
| `node-version`      | No          | Node.js version (default: 20)                   |

## Example Clients

- `examples/clients/typescript/everything-client.ts` - Single client that handles all scenarios based on scenario name (recommended)
- `examples/clients/typescript/test1.ts` - Simple MCP client (for reference)
- `examples/clients/typescript/auth-test.ts` - Well-behaved OAuth client (for reference)

## Available Scenarios

### Client Scenarios

- **initialize** - Tests MCP client initialization handshake
  - Validates protocol version
  - Validates clientInfo (name and version)
  - Validates server response handling
- **tools-call** - Tests tool invocation
- **auth/basic-dcr** - Tests OAuth Dynamic Client Registration flow
- **auth/basic-metadata-var1** - Tests OAuth with authorization metadata

### Server Scenarios

Run `npx @modelcontextprotocol/conformance list --server` to see all available server scenarios, including:

- **server-initialize** - Tests server initialization and capabilities
- **tools-list** - Tests tool listing endpoint
- **tools-call-\*** - Various tool invocation scenarios
- **resources-\*** - Resource management scenarios
- **prompts-\*** - Prompt management scenarios

## Running Against an SDK at a Specific Ref

The `sdk` subcommand clones an SDK repository at a given ref, builds it, and runs the **local** conformance build against it. This is the inner-loop tool for scenario authors and the basis for cross-SDK CI. Examples below use `npm start --` so they run from source — no `npm run build` between edits.

`--mode client` or `--mode server` is required — each invocation tests exactly one side, so client and server are run (and pass/fail) independently.

```bash
# Run the client conformance suite against typescript-sdk @main (v2)
npm start -- sdk typescript-sdk --mode client

# Run the server conformance suite (separate invocation)
npm start -- sdk typescript-sdk --mode server

# A specific main-line SHA or branch (v2 monorepo)
npm start -- sdk typescript-sdk@abc123f --mode client
npm start -- sdk typescript-sdk@some-branch --mode server

# The published v1.x line — separate entry (npm build), defaults to the v1.x branch
npm start -- sdk typescript-sdk-v1 --mode client
npm start -- sdk typescript-sdk-v1@v1.29.0 --mode server

# Use an existing local checkout (no clone, no fetch)
npm start -- sdk --path ../typescript-sdk --skip-build --mode client

# Narrow to one scenario / suite
npm start -- sdk --path ../typescript-sdk --mode server --scenario server-initialize
npm start -- sdk typescript-sdk --mode client --suite auth

# Target a specific spec version (passed through to the underlying run).
# When omitted, the SDK's `specVersion` from KNOWN_SDKS is used, if set —
# e.g. typescript-sdk-v1 defaults to 2025-11-25.
npm start -- sdk typescript-sdk --mode client --spec-version draft
```

Build/run commands for each official SDK are looked up by name from [`src/sdk-runner/known-sdks.ts`](src/sdk-runner/known-sdks.ts) — no config file is required in the SDK repo. Resolution order is **CLI flag > built-in entry**, so any field can be overridden on the command line for refs that diverge from the built-in.

An SDK can have more than one entry when its layout differs across major versions — e.g. `typescript-sdk` (v2, the `main` monorepo) and `typescript-sdk-v1` (the published npm v1.x line). An entry may set `defaultRef` (the branch used when you don't pass `@<ref>`) and `repo` (the real clone target when the entry name is an alias).

When the right invocation depends on the spec version being targeted, the entry carries it in `specOverrides` instead of a comment to copy from. The matching entry is merged over the base config when you pass `--spec-version` (or when the entry's own `specVersion` default applies), so version-specific runs need no extra flags:

```bash
# go-sdk's server pins -stateless=false for the dated-spec suites; its
# specOverrides['2026-07-28'] entry swaps in the stateless invocation, so
# this is the whole command:
npm start -- sdk go-sdk --mode server --suite all --spec-version 2026-07-28

# same for csharp-sdk (stateless URL), rust-sdk (STATELESS=1 env), and
# python-sdk (per-revision expected-failures baseline)
```

Explicit CLI flags still beat everything, config included — overriding a field for a one-off run:

```bash
npm start -- sdk go-sdk@my-fork-branch --mode server \
  --build-cmd 'go build -o ./.conformance-server ./experimental/server'
```

To add a new SDK to the matrix, add an entry to `KNOWN_SDKS`.

Clones are cached under `.sdk-under-test/` and reused (fetched) on subsequent runs.

## SDK Tier Assessment

The `tier-check` subcommand evaluates an MCP SDK repository against [SEP-1730](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1730) (the SDK Tiering System). There are two ways to run it, and they answer different questions.

### 1. The CLI, for the deterministic half

Conformance pass rates, issue triage, P0 resolution, labels, releases, policy files. No AI, no judgment, reproducible.

```bash
gh auth login

# fastest: everything except conformance
npx @modelcontextprotocol/conformance tier-check \
  --repo modelcontextprotocol/typescript-sdk --skip-conformance

# with conformance, scored against the revisions the SDK claims.
# start the SDK's everything server first, in its own terminal.
npx @modelcontextprotocol/conformance tier-check \
  --repo modelcontextprotocol/typescript-sdk \
  --conformance-server-url http://localhost:3000/mcp \
  --client-cmd '<command that runs the SDK conformance client>' \
  --requirements 2025-11-25,2026-07-28
```

Omit `--client-cmd` and the client leg is skipped and reported as a gap. Omit
`--requirements` and scoring falls back to the suite as it stands today, which is
not what you want for a tier claim; see [Conformance Requirements](#conformance-requirements).

### 2. The skill, for the whole assessment

The CLI cannot judge documentation coverage, dependency policy or roadmap quality, and those decide the tier as much as conformance does. The [`mcp-sdk-tier-audit`](.claude/skills/mcp-sdk-tier-audit/README.md) skill runs the CLI, adds those evaluations, and writes a full report with a remediation plan. In Claude Code, from a checkout of this repo:

```
/mcp-sdk-tier-audit <local-sdk-path> <conformance-server-url> '<client-cmd>' --requirements 2025-11-25,2026-07-28
```

The server must already be running and stay up for the whole audit. Expect a few minutes.

### Reading the result

```
Scored against 2025-11-25 and 2026-07-28, each run at its own wire version.

    Server   67/67 required scenarios (100%)
    Client   50/50 required scenarios (100%)

  Not scored (8 run, 4 failing, no effect on tier):
    ✗ auth/dpop (extension)
    ✗ json-schema-2020-12-preservation (added-after-release)

Tier 1 Blockers:
  • triage
  • p0_resolution
```

- **Required scenarios** are the only ones that move the number. `67/67` spans every revision listed: a scenario belonging to both runs once per revision, on that revision's wire, and both have to pass.
- **Not scored** ran and is reported so you can see it, but cannot fail the tier. `extension` means optional by definition; `added-after-release` means the scenario did not exist when that revision shipped. A failure here is information, not a blocker.
- **Not measured** is different from either, and means the run could not happen at all, e.g. a requirement set naming a scenario this build no longer has. Treat it as a broken invocation, never as an SDK failure.
- **Tier 1 blockers** lists every requirement short of Tier 1. Conformance absent from that list means the SDK met every requirement each listed revision imposes.

The exit code follows the same rule: it reflects required scenarios only, so an implementation that meets a revision's requirements exits 0 even with failing extensions.

In `--output json`, `passed` / `failed` / `total` describe the scored set and so always agree with `pass_rate`; anything run without being scored is counted separately under `not_scored`.

## Architecture

See `src/runner/DESIGN.md` for detailed architecture documentation.

### Key Components

- **Runner** (`src/runner/`) - Orchestrates test execution and result generation
  - `client.ts` - Client testing implementation
  - `server.ts` - Server testing implementation
  - `utils.ts` - Shared utilities
  - `index.ts` - Public API exports
- **CLI** (`src/index.ts`) - Command-line interface using Commander.js
- **Scenarios** (`src/scenarios/`) - Test scenarios with expected behaviors
- **Checks** (`src/checks/`) - Conformance validation functions
- **Types** (`src/types.ts`) - Shared type definitions

## Adding New Scenarios

1. Create a new directory in `src/scenarios/<scenario-name>/`
2. Implement the `Scenario` interface with `start()`, `stop()`, and `getChecks()`
3. Register the scenario in `src/scenarios/index.ts`

See `src/scenarios/initialize/` for a reference implementation.
