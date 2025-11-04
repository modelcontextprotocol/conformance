/**
 * Lifecycle test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';

export class ServerInitializeScenario implements ClientScenario {
  name = 'server-initialize';
  description = 'Test basic server initialization handshake';

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
