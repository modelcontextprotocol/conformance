/**
 * Session lifecycle conformance test scenario for MCP servers.
 *
 * Verifies the two server-side guarantees the Streamable HTTP transport spec
 * places on session termination:
 *
 *   1. The server accepts an HTTP DELETE that carries the issued session ID.
 *   2. After such a DELETE, a subsequent request bearing the terminated
 *      session ID is rejected with HTTP 404 Not Found.
 *
 * See https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
 */

import { ClientScenario, ConformanceCheck } from '../../types';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Session-Management',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management'
  }
];

const PROTOCOL_VERSION = '2025-11-25';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: 'conformance-session-lifecycle-test',
      version: '1.0.0'
    }
  }
};

const TOOLS_LIST_BODY = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {}
};

export class SessionLifecycleScenario implements ClientScenario {
  name = 'server-session-lifecycle';
  readonly source = { introducedIn: '2025-03-26' } as const;
  description = `Verify the server honours the streamable-HTTP session
termination contract.

**Server Implementation Requirements:**

- Accept an HTTP DELETE to the MCP endpoint that carries the issued
  \`Mcp-Session-Id\` header, responding with a 2xx status (or 405 if the
  server does not support explicit termination).
- After such a DELETE, return HTTP 404 Not Found for subsequent requests
  bearing the terminated session ID.

Servers without session management (stateless) are reported as SKIPPED.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let sessionId: string | null = null;
    try {
      // initialize MUST NOT carry MCP-Protocol-Version (the version is being
      // negotiated by the initialize handshake itself).
      const initResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(INITIALIZE_BODY)
      });

      sessionId = initResponse.headers.get('mcp-session-id');

      if (!sessionId) {
        checks.push({
          id: 'server-session-lifecycle-skipped',
          name: 'SessionLifecycleSkipped',
          description:
            'Server is stateless (no MCP-Session-Id) — lifecycle checks not applicable',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: {
            message:
              'Server did not return an MCP-Session-Id header; session lifecycle does not apply.'
          }
        });
        return checks;
      }

      // Complete the handshake so the server treats the session as live.
      await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'mcp-session-id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });

      // Step 1: DELETE the session.
      const deleteResponse = await fetch(serverUrl, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sessionId,
          'MCP-Protocol-Version': PROTOCOL_VERSION
        }
      });

      const deleteAccepted =
        deleteResponse.status >= 200 && deleteResponse.status < 300;
      const deleteNotSupported = deleteResponse.status === 405;

      if (deleteAccepted) {
        checks.push({
          id: 'server-session-delete-accepted',
          name: 'SessionDeleteAccepted',
          description:
            'Server accepts HTTP DELETE on the issued session ID with a 2xx response',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: { statusCode: deleteResponse.status }
        });
      } else if (deleteNotSupported) {
        checks.push({
          id: 'server-session-delete-accepted',
          name: 'SessionDeleteAccepted',
          description:
            'Server accepts HTTP DELETE on the issued session ID with a 2xx response',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: {
            statusCode: 405,
            message:
              'Server returned 405 Method Not Allowed; spec permits servers to refuse explicit DELETE.'
          }
        });
        // If the server refused DELETE, the terminated-returns-404 check has
        // nothing to assert against.
        checks.push({
          id: 'server-session-terminated-returns-404',
          name: 'SessionTerminatedReturns404',
          description:
            'Server returns HTTP 404 for requests bearing a terminated session ID',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: {
            message:
              'Skipped because the server does not support explicit session termination (405 on DELETE).'
          }
        });
        return checks;
      } else {
        checks.push({
          id: 'server-session-delete-accepted',
          name: 'SessionDeleteAccepted',
          description:
            'Server accepts HTTP DELETE on the issued session ID with a 2xx response',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Expected 2xx (or 405), got ${deleteResponse.status}`,
          specReferences: SPEC_REFERENCES,
          details: { statusCode: deleteResponse.status }
        });
        // The terminated-returns-404 check would be misleading without a
        // successful DELETE; skip it.
        checks.push({
          id: 'server-session-terminated-returns-404',
          name: 'SessionTerminatedReturns404',
          description:
            'Server returns HTTP 404 for requests bearing a terminated session ID',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: {
            message:
              'Skipped because the preceding DELETE did not succeed; cannot verify 404 behaviour on a terminated session.'
          }
        });
        return checks;
      }

      // Step 2: Re-send a request with the terminated session ID and expect 404.
      const afterTerminationResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'mcp-session-id': sessionId
        },
        body: JSON.stringify(TOOLS_LIST_BODY)
      });

      if (afterTerminationResponse.status === 404) {
        checks.push({
          id: 'server-session-terminated-returns-404',
          name: 'SessionTerminatedReturns404',
          description:
            'Server returns HTTP 404 for requests bearing a terminated session ID',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFERENCES,
          details: { statusCode: 404 }
        });
      } else {
        checks.push({
          id: 'server-session-terminated-returns-404',
          name: 'SessionTerminatedReturns404',
          description:
            'Server returns HTTP 404 for requests bearing a terminated session ID',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Expected 404 on terminated session ID, got ${afterTerminationResponse.status}`,
          specReferences: SPEC_REFERENCES,
          details: { statusCode: afterTerminationResponse.status }
        });
      }
    } catch (error) {
      checks.push({
        id: 'server-session-lifecycle-error',
        name: 'SessionLifecycleError',
        description: 'Session lifecycle test execution',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to exercise session lifecycle: ${
          error instanceof Error ? error.message : String(error)
        }`,
        specReferences: SPEC_REFERENCES
      });
    }

    return checks;
  }
}
