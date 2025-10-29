# Initialize Scenario Implementation TODO

## Overview

The `initialize` scenario tests the MCP client initialization handshake according to the MCP specification lifecycle requirements.

## Architecture

### Scenario Interface

Each scenario provides server setup/teardown and result retrieval:

```typescript
interface Scenario {
  name: string;
  description: string;
  
  // Start test server(s), return URLs
  start(): Promise<ScenarioUrls>;
  
  // Stop test server(s) and cleanup
  stop(): Promise<void>;
  
  // Get conformance check results from server
  getChecks(): ConformanceCheck[];
}

interface ScenarioUrls {
  serverUrl: string;      // MCP server URL (required)
  authUrl?: string;       // Auth server URL (optional, for auth scenarios)
}
```

### Flow Control (Runner's Responsibility)

The runner orchestrates:
1. **Start Scenario**: Call `scenario.start()` to get server URL(s)
2. **Execute Client**: Spawn client process with server URL appended
3. **Capture Output**: Collect stdout/stderr from client
4. **Wait for Completion**: Wait for client to exit (or timeout)
5. **Get Results**: Call `scenario.getChecks()` to retrieve conformance checks
6. **Stop Scenario**: Call `scenario.stop()` to shutdown server(s)
7. **Write Results**: Save checks, stdout, stderr to `results/<scenario>-<timestamp>/`

### Server Responsibilities

The test server:
- Captures MCP protocol interactions
- **Runs conformance checks internally** as interactions occur
- Stores checks for retrieval via `getChecks()`
- Supports clean shutdown

## Implementation Tasks

### 1. Create Test Server (`server.ts`)

- [ ] Implement `InitializeTestServer` class with:
  - `constructor()` - set up server
  - `start(): Promise<number>` - start listening on random port, return port number
  - `stop(): Promise<void>` - close server and connections
  - `getChecks(): ConformanceCheck[]` - return conformance check results
  
- [ ] Server behavior:
  - Accept HTTP connections (dummy for now, MCP later)
  - Capture the `initialize` request from client
  - **Run conformance checks immediately** using existing check functions:
    - `createClientInitializationCheck(initializeRequest)`
    - Store checks in internal array
  - Respond with valid `initialize` response:
    - `protocolVersion: "2025-06-18"`
    - `serverInfo: { name: "test-server", version: "1.0.0" }`
    - `capabilities: {}`
  - After response, optionally run server info check:
    - `createServerInfoCheck(serverInfo)` (validates we provided proper info)

### 2. Create Scenario Class (`index.ts`)

- [ ] Implement `InitializeScenario` class:
  ```typescript
  export class InitializeScenario implements Scenario {
    name = 'initialize';
    description = 'Tests MCP client initialization handshake';
    
    private server: InitializeTestServer | null = null;
    
    async start(): Promise<ScenarioUrls> {
      this.server = new InitializeTestServer();
      const port = await this.server.start();
      return {
        serverUrl: `http://localhost:${port}`
      };
    }
    
    async stop(): Promise<void> {
      if (this.server) {
        await this.server.stop();
        this.server = null;
      }
    }
    
    getChecks(): ConformanceCheck[] {
      if (!this.server) {
        return [];
      }
      return this.server.getChecks();
    }
  }
  ```

- [ ] Export singleton instance: `export const initializeScenario = new InitializeScenario();`

### 3. Scenario Registry (`src/scenarios/index.ts`)

- [ ] Create scenario registry:
  ```typescript
  import { initializeScenario } from './initialize/index.js';
  
  export const scenarios = new Map<string, Scenario>([
    ['initialize', initializeScenario],
    // future scenarios here
  ]);
  
  export function getScenario(name: string): Scenario | undefined {
    return scenarios.get(name);
  }
  ```

## File Structure

```
src/scenarios/
├── index.ts (scenario registry/map)
└── initialize/
    ├── TODO.md (this file - delete when complete)
    ├── index.ts (InitializeScenario class)
    └── server.ts (InitializeTestServer class)
```

## Example Usage

From runner:

```typescript
import { getScenario } from './scenarios/index.js';

const scenario = getScenario('initialize');
if (!scenario) {
  throw new Error('Unknown scenario: initialize');
}

// Start server
const urls = await scenario.start();

try {
  // Execute client (runner's responsibility)
  const clientOutput = await executeClient(clientCommand, urls.serverUrl);
  
  // Get checks from scenario
  const checks = scenario.getChecks();
  
  // Write results (runner's responsibility)
  await writeResults(outputDir, { checks, ...clientOutput });
} finally {
  // Stop server
  await scenario.stop();
}
```

## Conformance Checks

The server runs these checks (from `src/checks.ts`):
1. `createClientInitializationCheck(initializeRequest)` - validates client's initialize request
2. `createServerInfoCheck(serverInfo)` - validates server info was provided (optional)

Additional checks to consider:
- Client exit code validation (runner handles this)
- Connection established successfully
- No protocol errors

## Dependencies

- `http` for HTTP server (dummy for prototyping)
- Existing check functions from `src/checks.ts`

Note: The runner handles `child_process.spawn` and `fs/promises` for file writing.

## Testing

After implementation:
- [ ] Test with example client: `tsx examples/clients/typescript/test1.ts`
- [ ] Verify checks array is populated correctly
- [ ] Verify server starts and stops cleanly
- [ ] Test with broken client to ensure checks catch issues
- [ ] Use runner to execute full test flow

## Notes

- **Runner executes the client**, not the scenario
- **Scenario only manages server lifecycle** (start/stop) and provides results (getChecks)
- Server does checks internally and stores them
- Clean shutdown is critical - runner should use try/finally for scenario.stop()
- Start with dummy HTTP server, upgrade to MCP later
- For auth scenarios, return both `serverUrl` and `authUrl` from `start()`
