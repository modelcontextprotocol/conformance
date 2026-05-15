/**
 * MCP-Protocol-Version header validation scenario for MCP servers (HTTP transport).
 *
 * Spec (2025-06-18 / 2025-11-25, basic/transports#protocol-version-header):
 *   "If the server receives a request with an invalid or unsupported
 *    MCP-Protocol-Version, it MUST respond with 400 Bad Request."
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';

const VALID_PROTOCOL_VERSION = '2025-11-25';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Protocol-Version-Header',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header'
  }
];

interface HeaderCase {
  id: string;
  name: string;
  headerValue: string;
  reason: string;
}

const CASES: HeaderCase[] = [
  {
    id: 'server-protocol-version-header-malformed',
    name: 'ServerProtocolVersionHeaderMalformed',
    headerValue: 'invalid-protocol-version',
    reason: 'malformed (not a date string)'
  },
  {
    id: 'server-protocol-version-header-unsupported-past',
    name: 'ServerProtocolVersionHeaderUnsupportedPast',
    headerValue: '2000-01-01',
    reason:
      'well-formed but unsupported (lexicographically before any real version)'
  },
  {
    id: 'server-protocol-version-header-unsupported-future',
    name: 'ServerProtocolVersionHeaderUnsupportedFuture',
    headerValue: '2099-01-01',
    reason:
      'well-formed but unsupported (lexicographically after any real version)'
  }
];

export class ServerProtocolVersionHeaderScenario implements ClientScenario {
  name = 'server-protocol-version-header';
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
  description = `Test that the server rejects invalid or unsupported \`MCP-Protocol-Version\` header values with HTTP 400.

**Spec requirement** (basic/transports#protocol-version-header):
> If the server receives a request with an invalid or unsupported \`MCP-Protocol-Version\`, it **MUST** respond with \`400 Bad Request\`.

This scenario sends a \`tools/list\` request (without prior \`initialize\`) using three bad header values:
- a malformed string (\`invalid-protocol-version\`)
- a well-formed but unsupported past date (\`2000-01-01\`)
- a well-formed but unsupported future date (\`2099-01-01\`)

The past/future pair catches servers that validate via string comparison against a single bound rather than an explicit allowlist of supported versions.

Each header value is tested twice: once on a fresh connection without a session (pre-init), and once after a successful \`initialize\` handshake with a valid \`Mcp-Session-Id\` (post-init). The post-init checks isolate header validation from session-ID validation on servers that require sessions.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    for (const c of CASES) {
      checks.push(await this.runCase(serverUrl, c, 'pre-init'));
    }

    let sessionId: string | null;
    try {
      sessionId = await this.initialize(serverUrl);
    } catch (error) {
      const errorMessage = `Failed to initialize session for post-init checks: ${error instanceof Error ? error.message : String(error)}`;
      for (const c of CASES) {
        checks.push({
          id: `${c.id}-post-init`,
          name: `${c.name}PostInit`,
          description: `Server responds 400 to MCP-Protocol-Version header that is ${c.reason} (after initialize)`,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage,
          specReferences: SPEC_REFERENCES
        });
      }
      return checks;
    }

    for (const c of CASES) {
      checks.push(await this.runCase(serverUrl, c, 'post-init', sessionId));
    }

    return checks;
  }

  private async initialize(serverUrl: string): Promise<string | null> {
    const initResponse = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': VALID_PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: VALID_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'conformance-protocol-version-header-test',
            version: '1.0.0'
          }
        }
      })
    });

    if (!initResponse.ok) {
      throw new Error(
        `initialize returned ${initResponse.status} ${initResponse.statusText}`
      );
    }

    const sessionId = initResponse.headers.get('mcp-session-id');

    await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': VALID_PROTOCOL_VERSION,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      })
    });

    return sessionId;
  }

  private async runCase(
    serverUrl: string,
    c: HeaderCase,
    phase: 'pre-init' | 'post-init',
    sessionId?: string | null
  ): Promise<ConformanceCheck> {
    const idSuffix = phase === 'post-init' ? '-post-init' : '';
    const nameSuffix = phase === 'post-init' ? 'PostInit' : '';
    const phaseLabel =
      phase === 'post-init' ? ' (after initialize)' : ' (before initialize)';
    const description = `Server responds 400 to MCP-Protocol-Version header that is ${c.reason}${phaseLabel}`;
    const timestamp = new Date().toISOString();

    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': c.headerValue,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        })
      });

      let body: unknown = null;
      try {
        body = await response.text();
      } catch {
        // ignore body read errors
      }

      const details = {
        phase,
        sentHeader: c.headerValue,
        sessionId: sessionId ?? null,
        statusCode: response.status,
        body
      };

      if (response.status === 400) {
        return {
          id: `${c.id}${idSuffix}`,
          name: `${c.name}${nameSuffix}`,
          description,
          status: 'SUCCESS',
          timestamp,
          specReferences: SPEC_REFERENCES,
          details
        };
      }

      return {
        id: `${c.id}${idSuffix}`,
        name: `${c.name}${nameSuffix}`,
        description,
        status: 'FAILURE',
        timestamp,
        errorMessage: `Expected HTTP 400 for MCP-Protocol-Version "${c.headerValue}", got ${response.status}`,
        specReferences: SPEC_REFERENCES,
        details
      };
    } catch (error) {
      return {
        id: `${c.id}${idSuffix}`,
        name: `${c.name}${nameSuffix}`,
        description,
        status: 'FAILURE',
        timestamp,
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFERENCES,
        details: { phase, sentHeader: c.headerValue }
      };
    }
  }
}
