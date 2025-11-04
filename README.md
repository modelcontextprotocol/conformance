# MCP Conformance Test Framework

A framework for testing MCP (Model Context Protocol) client implementations against the specification.

> [!WARNING] This repository is a work in progress and is unstable. Join the conversation in the #conformance-testing-wg in the MCP Contributors discord.

## Quick Start

### Testing Clients

```bash
npm install
npm run start -- --command "tsx examples/clients/typescript/test1.ts" --scenario initialize
```

### Testing Servers

```bash
npm run test:server -- --server-url http://localhost:3000/mcp --all
```

## Overview

The conformance test framework validates MCP client implementations by:

1. Starting a test server for the specified scenario
2. Running the client implementation with the test server URL
3. Capturing MCP protocol interactions
4. Running conformance checks against the specification
5. Generating detailed test results

## Usage

```bash
npm run start -- --command "<client-command>" --scenario <scenario-name>
```

- `--command` - The command to run your MCP client (can include flags)
- `--scenario` - The test scenario to run (e.g., "initialize")

The framework appends the server URL as the final argument to your command.

## Test Results

Results are saved to `results/<scenario>-<timestamp>/`:

- `checks.json` - Array of conformance check results with pass/fail status
- `stdout.txt` - Client stdout output
- `stderr.txt` - Client stderr output

## Example Clients

- `examples/clients/typescript/test1.ts` - Valid MCP client (passes all checks)
- `examples/clients/typescript/test-broken.ts` - Invalid client missing required fields (fails checks)

## Available Scenarios

- **initialize** - Tests MCP client initialization handshake
    - Validates protocol version
    - Validates clientInfo (name and version)
    - Validates server response handling

## Architecture

See `src/runner/DESIGN.md` for detailed architecture documentation.

### Key Components

- **Runner** (`src/runner/`) - Orchestrates test execution and result generation
- **Scenarios** (`src/scenarios/`) - Test scenarios with custom server implementations
- **Checks** (`src/checks.ts`) - Conformance validation functions
- **Types** (`src/types.ts`) - Shared type definitions

## Adding New Scenarios

1. Create a new directory in `src/scenarios/<scenario-name>/`
2. Implement the `Scenario` interface with `start()`, `stop()`, and `getChecks()`
3. Register the scenario in `src/scenarios/index.ts`

See `src/scenarios/initialize/` for a reference implementation.
