/**
 * Stateless server test scenario
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import { connectToServer } from './client-helper';

export class StatelessServerCheckScenario implements ClientScenario {
  name = 'stateless-server';
  specVersions: SpecVersion[] = ['2025-03-26', '2025-06-18', '2025-11-25'];
  description = `Test that a stateless server correctly omits session IDs and rejects GET/DELETE.

**Server Implementation Requirements:**

**Transport**: Streamable HTTP with \`sessionIdGenerator: undefined\`

**Requirements**:
- MUST NOT include \`Mcp-Session-Id\` in any response headers
- MUST accept POST requests without \`Mcp-Session-Id\` header
- MUST return 405 for GET requests
- MUST return 405 for DELETE requests
- MUST handle tool calls without session state

This test verifies servers that intentionally omit session management.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    // Initialize via raw fetch and verify no session header
    try {
      const initResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
              name: 'conformance-stateless-test',
              version: '1.0.0'
            }
          },
          id: 1
        })
      });

      const sessionHeader = initResponse.headers.get('mcp-session-id');

      checks.push({
        id: 'stateless-server-no-session-header',
        name: 'StatelessServerNoSessionHeader',
        description:
          'Stateless server omits Mcp-Session-Id from initialize response',
        status: sessionHeader ? 'FAILURE' : 'SUCCESS',
        timestamp: new Date().toISOString(),
        errorMessage: sessionHeader
          ? `Server sent Mcp-Session-Id: ${sessionHeader}`
          : undefined,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ],
        details: { serverUrl }
      });
    } catch (error) {
      checks.push({
        id: 'stateless-server-no-session-header',
        name: 'StatelessServerNoSessionHeader',
        description:
          'Stateless server omits Mcp-Session-Id from initialize response',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    // Connect via SDK (POST without session header) and call a tool
    let connection;
    try {
      connection = await connectToServer(serverUrl);

      checks.push({
        id: 'stateless-server-post-without-session',
        name: 'StatelessServerPostWithoutSession',
        description: 'Server accepts requests without Mcp-Session-Id header',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ],
        details: { serverUrl }
      });
    } catch (error) {
      checks.push({
        id: 'stateless-server-post-without-session',
        name: 'StatelessServerPostWithoutSession',
        description: 'Server accepts requests without Mcp-Session-Id header',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    // GET returns 405
    try {
      const getResponse = await fetch(serverUrl, { method: 'GET' });

      checks.push({
        id: 'stateless-server-get-405',
        name: 'StatelessServerGet405',
        description: 'Stateless server returns 405 for GET requests',
        status: getResponse.status === 405 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          getResponse.status !== 405
            ? `Expected 405, got ${getResponse.status}`
            : undefined,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ],
        details: { status: getResponse.status }
      });
    } catch (error) {
      checks.push({
        id: 'stateless-server-get-405',
        name: 'StatelessServerGet405',
        description: 'Stateless server returns 405 for GET requests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    // DELETE returns 405
    try {
      const deleteResponse = await fetch(serverUrl, { method: 'DELETE' });

      checks.push({
        id: 'stateless-server-delete-405',
        name: 'StatelessServerDelete405',
        description: 'Stateless server returns 405 for DELETE requests',
        status: deleteResponse.status === 405 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          deleteResponse.status !== 405
            ? `Expected 405, got ${deleteResponse.status}`
            : undefined,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ],
        details: { status: deleteResponse.status }
      });
    } catch (error) {
      checks.push({
        id: 'stateless-server-delete-405',
        name: 'StatelessServerDelete405',
        description: 'Stateless server returns 405 for DELETE requests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    // Call a tool via SDK
    if (connection) {
      try {
        const result = await connection.client.callTool({
          name: 'start-notification-stream',
          arguments: { interval: 100, count: 1 }
        });

        checks.push({
          id: 'stateless-server-tools-call',
          name: 'StatelessServerToolsCall',
          description: 'Tool call completes successfully on a stateless server',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'MCP-Tools',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
            }
          ],
          details: { result }
        });
      } catch (error) {
        checks.push({
          id: 'stateless-server-tools-call',
          name: 'StatelessServerToolsCall',
          description: 'Tool call completes successfully on a stateless server',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: [
            {
              id: 'MCP-Tools',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
            }
          ]
        });
      }

      await connection.close();
    } else {
      checks.push({
        id: 'stateless-server-tools-call',
        name: 'StatelessServerToolsCall',
        description: 'Tool call completes successfully on a stateless server',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          'Failed: connection failed earlier, could not test tool call',
        specReferences: [
          {
            id: 'MCP-Tools',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}
