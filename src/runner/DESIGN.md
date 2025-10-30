# Conformance Test Runner Design

## Overview

The conformance test runner is a framework for testing MCP client implementations against the MCP specification. It executes client implementations in controlled scenarios and validates their behavior through a series of conformance checks.

## Architecture

### Components

1. **Runner** - Orchestrates test execution
2. **Test Server** - MCP server (and optionally auth server for auth scenarios)
3. **Client Process** - The MCP client implementation under test
4. **Scenario** - A specific test case with expected behaviors
5. **Checks** - Validation functions that produce ConformanceCheck results

### Execution Flow

```
1. Runner starts test server(s) on available port(s)
2. Runner spawns client process with server URL as final argument
3. Server captures MCP interactions
4. Runner captures client stdout/stderr
5. Scenario-specific checks are executed
6. Results are written to results/<scenario>-<timestamp>/
```

## CLI Interface

```bash
npm run start -- --command "tsx examples/clients/typescript/test1.ts --verbose" --scenario initialize
```

### Arguments

- `--command` - The command to run the client (can include existing flags)
- `--scenario` - The scenario to test (e.g., "initialize", "list-tools", "call-tool")

The runner will append the server URL as the final argument to the command.

## Scenarios

A scenario represents a specific test case that validates one or more aspects of MCP client behavior. Each scenario:

- Configures the test server with expected behavior
- May run multiple conformance checks
- Validates both client behavior and server responses

Example scenarios:

- `initialize` - Tests client initialization handshake
- `list-tools` - Tests tool discovery
- `call-tool` - Tests tool invocation
- `auth-flow` - Tests OAuth/authorization flows (requires auth server)

## Output Structure

Results are written to: `results/<scenario>-<timestamp>/`

Files:

- `checks.json` - Array of ConformanceCheck objects with validation results
- `stdout.txt` - Complete stdout from the client process
- `stderr.txt` - Complete stderr from the client process

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

## Future Enhancements

- **Test Suites** - Group multiple scenarios for convenience
- **Configurable Timeouts** - Per-scenario timeout configuration
- **Parallel Execution** - Run multiple scenarios concurrently
- **Custom Servers** - Allow custom MCP server implementations for advanced scenarios
- **Report Formats** - HTML, Markdown, or other human-readable formats
