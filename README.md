# MCP Conformance Test Framework

A framework for testing MCP (Model Context Protocol) client and server implementations against the specification.

> [!WARNING] This repository is a work in progress and is unstable. Join the conversation in the #conformance-testing-wg in the MCP Contributors discord.

## Quick Start

### Testing Clients

```bash
npx @modelcontextprotocol/conformance client --command "tsx examples/clients/typescript/test1.ts" --scenario initialize
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
- `--timeout` - Timeout in milliseconds (default: 30000)
- `--verbose` - Show verbose output

The framework appends the server URL as the final argument to your command.

### Server Testing

```bash
npx @modelcontextprotocol/conformance server --url <url> [--scenario <scenario>]
```

**Options:**

- `--url` - URL of the server to test
- `--scenario <scenario>` - Test scenario to run (e.g., "server-initialize"). Runs all available scenarios by default
- `--suite <suite>` - Suite to run: "active" (default), "all", "pending", or "auth"
- `--auth` - Include OAuth conformance tests when running active suite

### Authorization Server OAuth Conformity Testing

To test the OAuth implementation protecting your server:

```bash
# Run only OAuth conformance tests
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --suite auth

# Run a specific OAuth scenario
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --scenario server/auth-prm-discovery

## Test Results

**Client Testing** - Results are saved to `results/<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status
- `stdout.txt` - Client stdout output
- `stderr.txt` - Client stderr output

**Server Testing** - Results are saved to `results/server-<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status

## Example Clients

- `examples/clients/typescript/test1.ts` - Valid MCP client (passes all checks)
- `examples/clients/typescript/test-broken.ts` - Invalid client missing required fields (fails checks)

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
