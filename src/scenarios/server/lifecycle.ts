/**
 * Lifecycle test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import { connectToServer } from './client-helper';

export class ServerInitializeScenario implements ClientScenario {
  name = 'server-initialize';
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
  description = `Test basic server initialization handshake.

**Server Implementation Requirements:**

**Endpoint**: \`initialize\`

**Requirements**:
- Accept \`initialize\` request with client info and capabilities
- Return valid initialize response with server info, protocol version, and capabilities
- Accept \`initialized\` notification from client after handshake

This test verifies the server can complete the two-phase initialization handshake successfully.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      // The connection process already does initialization
      // Check that we have a connected client
      checks.push({
        id: 'server-initialize',
        name: 'ServerInitialize',
        description:
          'Server responds to initialize request with valid structure',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Initialize',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization'
          }
        ],
        details: {
          serverUrl,
          connected: true
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'server-initialize',
        name: 'ServerInitialize',
        description:
          'Server responds to initialize request with valid structure',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Initialize',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization'
          }
        ]
      });
    }

    return checks;
  }
}
