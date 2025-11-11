# Conformance Test Runner Design

## Overview

The conformance test runner is a framework for testing both MCP client and server implementations against the MCP specification. It provides two testing modes:

1. **Client Testing** - Executes client implementations in controlled scenarios and validates their behavior
2. **Server Testing** - Tests server implementations by acting as an MCP client and validating responses

## Architecture

### File Structure

```
src/runner/
├── index.ts      # Exports all public functions
├── client.ts     # Client testing implementation
├── server.ts     # Server testing implementation
└── utils.ts      # Shared utilities (formatting, file I/O, ANSI colors)
```

### Components

**Client Testing:**

1. **Runner** - Orchestrates test execution
2. **Test Server** - MCP server (and optionally auth server for auth scenarios)
3. **Client Process** - The MCP client implementation under test
4. **Scenario** - A specific test case with expected behaviors
5. **Checks** - Validation functions that produce ConformanceCheck results

**Server Testing:**

1. **Runner** - Orchestrates test execution
2. **Test Client** - MCP SDK client that connects to the server under test
3. **Server Process** - The MCP server implementation under test (external)
4. **Scenario** - A specific test case with expected server behaviors
5. **Checks** - Validation functions that produce ConformanceCheck results

### Execution Flow

**Client Testing:**

```
1. Runner starts test server(s) on available port(s)
2. Runner spawns client process with server URL as final argument
3. Server captures MCP interactions
4. Runner captures client stdout/stderr
5. Scenario-specific checks are executed
6. Results are written to results/<scenario>-<timestamp>/
```

**Server Testing:**

```
1. User starts their server implementation
2. Runner connects to server URL as an MCP client
3. Runner sends requests and captures responses
4. Scenario-specific checks validate server behavior
5. Results are written to results/server-<scenario>-<timestamp>/
```

## CLI Interface

The conformance suite provides a unified CLI with two main commands:

### Client Testing

```bash
# Run a single client scenario
npm run start -- client --command "tsx examples/clients/typescript/test1.ts" --scenario initialize

# With verbose output
npm run start -- client --command "tsx examples/clients/typescript/test1.ts" --scenario initialize --verbose

# With custom timeout
npm run start -- client --command "tsx examples/clients/typescript/test1.ts" --scenario initialize --timeout 60000
```

**Arguments:**

- `--command` - The command to run the client (can include existing flags)
- `--scenario` - The scenario to test (e.g., "initialize", "tools-call")
- `--timeout` - Timeout in milliseconds (default: 30000)
- `--verbose` - Show verbose output (JSON format)

The runner will append the server URL as the final argument to the command.

### Server Testing

```bash
# Run a single server scenario
npm run start -- server --url http://localhost:3000/mcp --scenario server-initialize

# Run all server scenarios (default when no --scenario specified)
npm run start -- server --url http://localhost:3000/mcp
```

**Arguments:**

- `--url` - URL of the server to test
- `--scenario <scenario>` - Scenario to test (optional, defaults to all scenarios if not specified)

### List Available Scenarios

```bash
# List all scenarios
npm run start -- list

# List only client scenarios
npm run start -- list --client

# List only server scenarios
npm run start -- list --server
```

## Validation

All CLI arguments are validated using Zod schemas (`src/schemas.ts`) before being passed to runner functions:

**Client Validation:**

- Command is non-empty
- Scenario exists in available scenarios
- Timeout is a positive integer

**Server Validation:**

- URL is a valid HTTP/HTTPS URL
- All specified scenarios exist (if provided)
- Defaults to all scenarios when no `--scenario` is specified

## Scenarios

A scenario represents a specific test case that validates one or more aspects of MCP behavior. Each scenario:

- Configures the test environment with expected behavior
- May run multiple conformance checks
- Validates both request/response patterns and protocol compliance

### Client Scenario Examples

- `initialize` - Tests client initialization handshake
- `tools-call` - Tests tool invocation
- `auth/basic-dcr` - Tests OAuth Dynamic Client Registration flow
- `auth/basic-metadata-var1` - Tests OAuth with authorization metadata variation 1

### Server Scenario Examples

- `server-initialize` - Tests server initialization and capabilities
- `tools-list` - Tests tool listing endpoint
- `tools-call-simple-text` - Tests tool invocation with text response
- `resources-list` - Tests resource listing
- `prompts-list` - Tests prompt listing
- `logging-set-level` - Tests logging level configuration

## Output Structure

Results are written to: `results/<scenario>-<timestamp>/` or `results/server-<scenario>-<timestamp>/`

**Client Testing Files:**

- `checks.json` - Array of ConformanceCheck objects with validation results
- `stdout.txt` - Complete stdout from the client process
- `stderr.txt` - Complete stderr from the client process

**Server Testing Files:**

- `checks.json` - Array of ConformanceCheck objects with validation results

### checks.json Format

```json
[
  {
    "id": "mcp-client-initialization",
    "name": "MCPClientInitialization",
    "description": "Validates that MCP client properly initializes with server",
    "status": "SUCCESS",
    "timestamp": "2024-10-29T14:30:00.000Z",
    "specReferences": [
      {
        "id": "MCP-Lifecycle",
        "url": "https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle"
      }
    ],
    "details": { ... }
  }
]
```

## Programmatic Usage

The runner can also be used programmatically:

```typescript
import { runConformanceTest, printClientResults, runServerConformanceTest, printServerResults } from './runner/index.js';

// Test a client
const clientResult = await runConformanceTest('tsx my-client.ts', 'initialize', 30000);
const { failed } = printClientResults(clientResult.checks);

// Test a server
const serverResult = await runServerConformanceTest('http://localhost:3000/mcp', 'server-initialize');
const { failed } = printServerResults(serverResult.checks);
```

## Shared Utilities

The `utils.ts` module provides shared functionality:

- **File Operations:** `ensureResultsDir()`, `createResultDir()`
- **Formatting:** `formatPrettyChecks()` for colored console output
- **Styling:** ANSI color constants and helpers

## Future Enhancements

- **Test Suites** - Group multiple scenarios for convenience
- **Configurable Timeouts** - Per-scenario timeout configuration
- **Parallel Execution** - Run multiple scenarios concurrently
- **Custom Servers** - Allow custom MCP server implementations for advanced scenarios
- **Report Formats** - HTML, Markdown, or other human-readable formats
- **Watch Mode** - Automatically re-run tests on file changes
- **Coverage Tracking** - Track which parts of the spec are tested
