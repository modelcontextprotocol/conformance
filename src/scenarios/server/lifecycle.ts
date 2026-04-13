/**
 * Lifecycle test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import { connectToServer } from './client-helper';

const VISIBLE_ASCII_REGEX = /^[\x21-\x7E]+$/;

const SESSION_SPEC_REFERENCES = [
  {
    id: 'MCP-Session-Management',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management'
  }
];

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
- If a session ID is assigned, it MUST only contain visible ASCII characters (0x21 to 0x7E)

This test verifies the server can complete the two-phase initialization handshake successfully,
and validates session ID format if one is assigned.`;

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
      return checks;
    }

    // Check: Session ID visible ASCII validation
    // Use a raw fetch to inspect the MCP-Session-Id response header,
    // since the SDK client transport does not expose it.
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: {
              name: 'conformance-session-id-test',
              version: '1.0.0'
            }
          }
        })
      });

      const sessionId = response.headers.get('mcp-session-id');

      if (!sessionId) {
        checks.push({
          id: 'server-session-id-visible-ascii',
          name: 'ServerSessionIdVisibleAscii',
          description:
            'Server-provided session ID uses only visible ASCII characters',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: SESSION_SPEC_REFERENCES,
          details: {
            message:
              'Server did not provide an MCP-Session-Id header (session ID is optional)'
          }
        });
      } else if (VISIBLE_ASCII_REGEX.test(sessionId)) {
        checks.push({
          id: 'server-session-id-visible-ascii',
          name: 'ServerSessionIdVisibleAscii',
          description:
            'Server-provided session ID uses only visible ASCII characters',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SESSION_SPEC_REFERENCES,
          details: {
            sessionId
          }
        });
      } else {
        checks.push({
          id: 'server-session-id-visible-ascii',
          name: 'ServerSessionIdVisibleAscii',
          description:
            'Server-provided session ID uses only visible ASCII characters',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            'Session ID contains characters outside visible ASCII range (0x21-0x7E)',
          specReferences: SESSION_SPEC_REFERENCES,
          details: {
            sessionId
          }
        });
      }
    } catch (error) {
      checks.push({
        id: 'server-session-id-visible-ascii',
        name: 'ServerSessionIdVisibleAscii',
        description:
          'Server-provided session ID uses only visible ASCII characters',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to send initialize request for session ID check: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SESSION_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
