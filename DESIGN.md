# MCP Conformance Test Framework Design

## Introduction

This document describes the design of the MCP Conformance Test Framework, a tool for validating Model Context Protocol (MCP) implementations against the specification. The framework enables both SDK developers and integrators to verify that their implementations behave correctly.

## Goals

1. **Validate MCP implementations** - Test both client and server implementations for specification compliance
2. **Simplify SDK development** - Provide a standardized way to verify behavior across different language implementations
3. **Enable debugging** - Capture protocol interactions for analysis and troubleshooting
4. **Ensure interoperability** - Reduce implementation differences that cause compatibility issues

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLI (index.ts)                            │
│                    Commander.js command interface                   │
└─────────────────────────────────────┬───────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                                   ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│      Client Testing Mode      │     │      Server Testing Mode      │
│       (runner/client.ts)      │     │       (runner/server.ts)      │
└───────────────┬───────────────┘     └───────────────┬───────────────┘
                │                                     │
                ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│     Scenario (test server)    │     │   ClientScenario (test client)│
│   scenarios/client/*.ts       │     │     scenarios/server/*.ts     │
└───────────────┬───────────────┘     └───────────────┬───────────────┘
                │                                     │
                ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│   Client Under Test (spawn)   │     │   Server Under Test (external)│
└───────────────────────────────┘     └───────────────────────────────┘
```

## Core Concepts

### Testing Modes

The framework supports two complementary testing modes:

#### 1. Client Testing Mode

Tests MCP client implementations by:
- Starting a controlled test server that implements specific MCP behaviors
- Spawning the client implementation as a child process
- Passing the server URL and scenario context to the client
- Capturing protocol interactions and validating client behavior

**Use case**: Validating that an MCP client correctly implements the protocol (initialization handshake, tool invocation, OAuth flows, etc.)

#### 2. Server Testing Mode

Tests MCP server implementations by:
- Connecting to an externally running server as an MCP client
- Executing test scenarios that make specific requests
- Validating server responses against specification requirements

**Use case**: Validating that an MCP server correctly handles client requests and returns spec-compliant responses

### Scenarios

A **Scenario** encapsulates a specific test case. Scenarios:
- Define the test environment setup
- Execute one or more conformance checks
- Produce structured results with pass/fail status

#### Client Scenarios (`Scenario` interface)

Used when testing clients. The framework runs a test server that the client connects to.

```typescript
interface Scenario {
  name: string;
  description: string;
  start(): Promise<ScenarioUrls>;  // Start test server(s)
  stop(): Promise<void>;            // Cleanup
  getChecks(): ConformanceCheck[];  // Return validation results
}
```

#### Server Scenarios (`ClientScenario` interface)

Used when testing servers. The framework acts as a client connecting to the server under test.

```typescript
interface ClientScenario {
  name: string;
  description: string;
  run(serverUrl: string): Promise<ConformanceCheck[]>;
}
```

### Conformance Checks

A **ConformanceCheck** is the atomic unit of validation. Each check:
- Has a unique identifier and human-readable name
- References specific sections of the MCP specification
- Reports one of five statuses: `SUCCESS`, `FAILURE`, `WARNING`, `SKIPPED`, `INFO`
- Includes optional details, error messages, and logs

```typescript
interface ConformanceCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  timestamp: string;
  specReferences?: SpecReference[];
  details?: Record<string, unknown>;
  errorMessage?: string;
  logs?: string[];
}
```

## Component Details

### CLI (`src/index.ts`)

The command-line interface built with Commander.js provides three commands:

- `client` - Run client conformance tests
- `server` - Run server conformance tests
- `list` - List available scenarios

Arguments are validated using Zod schemas before execution.

### Runner (`src/runner/`)

Orchestrates test execution and result generation.

**`client.ts`**:
- Starts scenario test server(s)
- Spawns the client process with:
  - Server URL as the final command argument
  - `MCP_CONFORMANCE_SCENARIO` environment variable (scenario name)
  - `MCP_CONFORMANCE_CONTEXT` environment variable (JSON with scenario-specific data)
- Captures stdout/stderr from the client
- Collects conformance checks from the scenario
- Writes results to the output directory

**`server.ts`**:
- Creates an MCP SDK client
- Connects to the server under test
- Executes ClientScenario test logic
- Collects and reports conformance checks

**`utils.ts`**:
- File I/O helpers for result directories
- Console formatting with ANSI colors
- Check status rendering

### Scenarios (`src/scenarios/`)

Organized by test type:

```
scenarios/
├── index.ts              # Scenario registry
├── request-logger.ts     # Protocol trace middleware
├── client/               # Client test scenarios
│   ├── initialize.ts
│   ├── tools_call.ts
│   ├── sse-retry.ts
│   ├── elicitation-defaults.ts
│   └── auth/             # OAuth/auth scenarios
│       ├── basic-cimd.ts
│       ├── client-credentials.ts
│       ├── discovery-metadata.ts
│       └── ...
└── server/               # Server test scenarios
    ├── lifecycle.ts
    ├── tools.ts
    ├── resources.ts
    ├── prompts.ts
    └── ...
```

### Protocol Tracing (`src/scenarios/request-logger.ts`)

Express middleware that captures all HTTP request/response pairs:
- Logs incoming requests with method, path, headers, and body
- Logs outgoing responses with status code, headers, and body
- Extracts MCP method from JSON-RPC request bodies
- Creates `INFO` status checks for each exchange

Protocol traces are useful for:
- Debugging test failures
- Understanding the exact protocol exchange
- Manual review of client/server behavior

### Checks (`src/checks/`)

Reusable validation functions that produce ConformanceCheck results:
- `client.ts` - Validations for client behavior
- `server.ts` - Validations for server responses

## Data Flow

### Client Testing Flow

```
1. User runs: conformance client --command "my-client" --scenario initialize

2. CLI parses and validates arguments

3. Runner loads scenario from registry

4. Scenario.start() creates test server(s)
   - Express app with MCP SDK server
   - Request logger middleware
   - Optional auth server

5. Runner spawns client process:
   - Command: "my-client <server-url>"
   - Env: MCP_CONFORMANCE_SCENARIO=initialize
   - Env: MCP_CONFORMANCE_CONTEXT={...}

6. Client connects to test server and performs operations

7. Request logger captures protocol exchanges

8. Scenario validates client behavior via getChecks()

9. Runner collects checks, stdout, stderr

10. Results written to results/<scenario>-<timestamp>/
    - checks.json
    - stdout.txt
    - stderr.txt
```

### Server Testing Flow

```
1. User runs: conformance server --url http://localhost:3000/mcp

2. CLI parses and validates arguments

3. Runner loads ClientScenario(s) from registry

4. For each scenario:
   a. Create MCP SDK client
   b. Connect to server URL
   c. ClientScenario.run(serverUrl) executes tests
   d. Scenario returns ConformanceCheck array

5. Results written to results/server-<scenario>-<timestamp>/
   - checks.json
```

## Scenario Categories

### Lifecycle Scenarios
- `initialize` - Client initialization handshake
- `server-initialize` - Server initialization response

### Protocol Feature Scenarios
- `tools-*` - Tool listing and invocation
- `resources-*` - Resource listing and reading
- `prompts-*` - Prompt listing and retrieval
- `logging-*` - Logging level configuration
- `ping` - Ping/pong keep-alive

### Authentication Scenarios
- `auth/basic-dcr` - Dynamic Client Registration
- `auth/basic-cimd` - Client ID from Metadata Discovery
- `auth/client-credentials` - Client credentials flow
- `auth/scope-handling` - OAuth scope handling

### Transport Scenarios
- `sse-retry` - SSE reconnection behavior
- `sse-polling` - SSE long-polling
- `sse-multiple-streams` - Multiple SSE connections

## Output Format

### Directory Structure

```
results/
├── initialize-2024-10-29T14-30-00-000Z/
│   ├── checks.json     # Conformance check results
│   ├── stdout.txt      # Client stdout (client testing only)
│   └── stderr.txt      # Client stderr (client testing only)
└── server-tools-list-2024-10-29T14-31-00-000Z/
    └── checks.json     # Conformance check results
```

### checks.json Format

```json
[
  {
    "id": "mcp-client-initialization",
    "name": "MCP Client Initialization",
    "description": "Client sends valid initialize request",
    "status": "SUCCESS",
    "timestamp": "2024-10-29T14:30:00.000Z",
    "specReferences": [
      {
        "id": "MCP-Lifecycle",
        "url": "https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle"
      }
    ],
    "details": {
      "protocolVersion": "2025-06-18",
      "clientInfo": { "name": "test-client", "version": "1.0.0" }
    }
  }
]
```

## Extensibility

### Adding New Scenarios

1. Create a new file in `src/scenarios/client/` or `src/scenarios/server/`
2. Implement `Scenario` (for client testing) or `ClientScenario` (for server testing)
3. Register in `src/scenarios/index.ts`

### Example: New Server Scenario

```typescript
// src/scenarios/server/my-feature.ts
import { ClientScenario, ConformanceCheck } from '../../types';
import { createTestClient } from './client-helper';

export class MyFeatureScenario implements ClientScenario {
  name = 'my-feature';
  description = 'Tests my feature behavior';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const client = await createTestClient(serverUrl);
    const checks: ConformanceCheck[] = [];

    try {
      // Test logic here
      const result = await client.someMethod();

      checks.push({
        id: 'my-feature-check',
        name: 'My Feature Check',
        description: 'Validates my feature works correctly',
        status: result.valid ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'MCP-MyFeature', url: '...' }],
        details: { result }
      });
    } finally {
      await client.close();
    }

    return checks;
  }
}
```

## Design Decisions

### Process-Based Client Testing

Clients are tested by spawning them as child processes. This approach:
- Enables testing any client implementation (any language)
- Isolates the client from the test framework
- Captures all output for debugging

Trade-offs:
- Requires clients to accept server URL as command-line argument
- Limited control over client internals

### In-Process Server Testing

Server testing uses the MCP SDK client directly. This approach:
- Provides full control over test requests
- Enables precise validation of responses
- Simpler setup than spawning processes

Trade-offs:
- Test client limited to TypeScript SDK capabilities
- May not catch transport-level issues

### Protocol Tracing via Middleware

Request logging is implemented as Express middleware rather than external packet capture. This:
- Requires no additional dependencies
- Works regardless of network configuration
- Integrates cleanly with check collection

### Structured Check Output

Using structured JSON output enables:
- Programmatic analysis of results
- Integration with CI/CD pipelines
- Comparison across test runs

## Future Considerations

- **Golden file comparison** - Store expected protocol traces for regression testing
- **Multi-SDK testing** - Automate testing across TypeScript, Python, Java SDKs
- **Coverage tracking** - Track which spec sections are tested
- **Live traffic analysis** - Protocol debugger for arbitrary MCP connections
- **Report generation** - HTML/Markdown summary reports
- **Watch mode** - Re-run tests on file changes
