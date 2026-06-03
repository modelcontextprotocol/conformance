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
- `--spec-version <version>` - Filter scenarios by spec version (e.g., `2025-11-25`, `DRAFT-2026-v1`; `draft` is accepted as an alias for the current draft identifier). The draft version selects the latest dated release plus any draft-only scenarios. When omitted, the version is inferred from the scenario's spec applicability (draft-only scenarios run at the draft version, everything else at the latest dated release); an explicitly requested version outside a scenario's applicability window skips the scenario (exit 0) unless `--force` is passed
- `--force` - Run a scenario even if it is not applicable at the requested `--spec-version`
- `--expected-failures <path>` - Path to YAML baseline file of known failures (see [Expected Failures](#expected-failures))
- `--timeout` - Timeout in milliseconds (default: 30000)
- `--verbose` - Show verbose output

The framework appends `<server-url>` as an argument to your command and sets the `MCP_CONFORMANCE_SCENARIO` environment variable to the scenario name. For scenarios that require additional context (e.g., client credentials), the `MCP_CONFORMANCE_CONTEXT` environment variable contains a JSON object with scenario-specific data. When `--spec-version` is passed, its resolved value is forwarded to the client process as `MCP_CONFORMANCE_PROTOCOL_VERSION`; example clients can use this value directly as their `protocolVersion`. SDKs that hard-code their protocol version can ignore it. Clients under test must derive the lifecycle from the protocol version they are asked to run: dated versions through `2025-11-25` use the stateful lifecycle (initialize handshake), while the 2026 draft (`DRAFT-2026-v1`) uses the stateless lifecycle (per-request `_meta`).

### Server Testing

```bash
npx @modelcontextprotocol/conformance server --url <url> [--scenario <scenario>]
```

**Options:**

- `--url` - URL of the server to test
- `--scenario <scenario>` - Test scenario to run (e.g., "server-initialize"). Runs all available scenarios by default
- `--suite <suite>` - Suite to run: "active" (default; excludes pending and draft-spec scenarios), "all", "draft" (scenarios targeting the in-progress draft spec), or "pending"
- `--expected-failures <path>` - Path to YAML baseline file of known failures (see [Expected Failures](#expected-failures))
- `--verbose` - Show verbose output

## Test Results

**Client Testing** - Results are saved to `results/<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status
- `stdout.txt` - Client stdout output
- `stderr.txt` - Client stderr output

**Server Testing** - Results are saved to `results/server-<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status

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
```

Build/run commands for each official SDK are looked up by name from [`src/sdk-runner/known-sdks.ts`](src/sdk-runner/known-sdks.ts) — no config file is required in the SDK repo. Resolution order is **CLI flag > built-in entry**, so any field can be overridden on the command line for refs that diverge from the built-in.

An SDK can have more than one entry when its layout differs across major versions — e.g. `typescript-sdk` (v2, the `main` monorepo) and `typescript-sdk-v1` (the published npm v1.x line). An entry may set `defaultRef` (the branch used when you don't pass `@<ref>`) and `repo` (the real clone target when the entry name is an alias). Overriding for a one-off ref:

```bash
npm start -- sdk owner/go-sdk@some-branch \
  --mode client \
  --build-cmd 'go build -tags mcp_go_client_oauth -o ./.conformance-client ./conformance/everything-client' \
  --client-cmd './.conformance-client'
```

To add a new SDK to the matrix, add an entry to `KNOWN_SDKS`.

Clones are cached under `.sdk-under-test/` and reused (fetched) on subsequent runs.

## SDK Tier Assessment

The `tier-check` subcommand evaluates an MCP SDK repository against [SEP-1730](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1730) (the SDK Tiering System):

```bash
# Without conformance tests (fastest)
gh auth login
npm run --silent tier-check -- --repo modelcontextprotocol/typescript-sdk --skip-conformance

# With conformance tests (start the everything server first)
npm run --silent tier-check -- \
  --repo modelcontextprotocol/typescript-sdk \
  --conformance-server-url http://localhost:3000/mcp
```

For a full AI-assisted assessment with remediation guide, use Claude Code:

```
/mcp-sdk-tier-audit <local-sdk-path> <conformance-server-url>
```

See [`.claude/skills/mcp-sdk-tier-audit/README.md`](.claude/skills/mcp-sdk-tier-audit/README.md) for full documentation.

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
