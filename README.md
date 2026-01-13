# MCP Conformance Test Framework

A framework for testing MCP (Model Context Protocol) client and server implementations against the specification.

> [!WARNING] This repository is a work in progress and is unstable. Join the conversation in the #conformance-testing-wg in the MCP Contributors discord.

## Quick Start

### Testing Clients

```bash
# Test your client implementation
npx @modelcontextprotocol/conformance client --command "<your-client-command>" --scenario initialize

# Run an entire suite of tests
npx @modelcontextprotocol/conformance client --command "<your-client-command>" --suite auth
```

> **Note**: For TypeScript SDK development, see [examples/README.md](examples/README.md) for the recommended setup using the conformance client in the typescript-sdk repository.

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
- `--suite` - Run a suite of tests in parallel (e.g., "auth")
- `--timeout` - Timeout in milliseconds (default: 30000)
- `--verbose` - Show verbose output

The framework appends `<server-url>` as an argument to your command and sets the `MCP_CONFORMANCE_SCENARIO` environment variable to the scenario name. For scenarios that require additional context (e.g., client credentials), the `MCP_CONFORMANCE_CONTEXT` environment variable contains a JSON object with scenario-specific data.

### Server Testing

```bash
npx @modelcontextprotocol/conformance server --url <url> [--scenario <scenario>]
```

**Options:**

- `--url` - URL of the server to test
- `--scenario <scenario>` - Test scenario to run (e.g., "server-initialize". Runs all available scenarios by default

## Test Results

**Client Testing** - Results are saved to `results/<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status
- `stdout.txt` - Client stdout output
- `stderr.txt` - Client stderr output

**Server Testing** - Results are saved to `results/server-<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status

## Example Implementations

TypeScript conformance client and server examples are maintained in the [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) repository:

- **Client**: `src/conformance/everything-client.ts` - Single client that handles all scenarios based on scenario name
- **Server**: `examples/server/` - Various server implementations for testing

See [examples/README.md](examples/README.md) for instructions on local development with the TypeScript SDK.

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
