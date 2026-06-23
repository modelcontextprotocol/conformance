/**
 * DNS Rebinding Protection test scenarios for MCP servers
 *
 * Tests that localhost MCP servers properly validate Host or Origin headers
 * to prevent DNS rebinding attacks. See GHSA-w48q-cv73-mx4w for details.
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import { buildStandardHeaders, type RunContext } from '../../connection';
import { isStatefulVersion } from '../../connection/select';
import { request } from 'undici';

const SPEC_REFERENCES = [
  {
    id: 'MCP-DNS-Rebinding-Protection',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices#local-mcp-server-compromise'
  },
  {
    id: 'MCP-Transport-Security',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning'
  }
];

/**
 * Check if URL is a localhost URL
 */
function isLocalhostUrl(serverUrl: string): boolean {
  const url = new URL(serverUrl);
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Get the host header value from a URL (hostname:port)
 */
function getHostFromUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return url.host; // includes port if present
}

/**
 * Build a request body that any server for the given spec version should
 * accept without prior setup (initialize for the stateful lifecycle,
 * server/discover with _meta for the stateless lifecycle).
 */
function probeBody(specVersion: string): {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
} {
  const clientInfo = {
    name: 'conformance-dns-rebinding-test',
    version: '1.0.0'
  };
  if (specVersion === DRAFT_PROTOCOL_VERSION) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': specVersion,
          'io.modelcontextprotocol/clientInfo': clientInfo,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    };
  }
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: specVersion,
      capabilities: {},
      clientInfo
    }
  };
}

/**
 * Send an MCP request with custom Host and Origin headers.
 * Both headers are set to the same value so that servers checking either
 * Host or Origin will properly detect the rebinding attempt.
 */
async function sendRequestWithHostAndOrigin(
  serverUrl: string,
  hostOrOrigin: string,
  specVersion: string
): Promise<{ statusCode: number; body: unknown; sessionId?: string }> {
  // Build the SEP-2243 standard headers (Mcp-Method, Accept, ...) for the
  // probe's JSON-RPC method so a strictly-conformant server only rejects the
  // request for the Host/Origin values under test, then layer the
  // scenario-specific headers on top.
  const probe = probeBody(specVersion);
  const response = await request(serverUrl, {
    method: 'POST',
    headers: buildStandardHeaders(probe.method, probe.params, {
      headers: {
        Host: hostOrOrigin,
        Origin: `http://${hostOrOrigin}`,
        'MCP-Protocol-Version': specVersion
      }
    }),
    body: JSON.stringify(probe)
  });

  let body: unknown;
  try {
    body = await response.body.json();
  } catch {
    body = null;
  }

  const sessionId = response.headers['mcp-session-id'];
  return {
    statusCode: response.statusCode,
    body,
    sessionId: Array.isArray(sessionId) ? sessionId[0] : sessionId
  };
}

async function sendInitializedNotification(
  serverUrl: string,
  hostOrOrigin: string,
  specVersion: string,
  sessionId?: string
): Promise<{ statusCode: number; body: unknown }> {
  const method = 'notifications/initialized';
  const response = await request(serverUrl, {
    method: 'POST',
    headers: buildStandardHeaders(method, undefined, {
      headers: {
        Host: hostOrOrigin,
        Origin: `http://${hostOrOrigin}`,
        'MCP-Protocol-Version': specVersion,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      }
    }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method
    })
  });

  let body: unknown;
  try {
    body = await response.body.json();
  } catch {
    body = null;
  }

  return {
    statusCode: response.statusCode,
    body
  };
}

export class DNSRebindingProtectionScenario implements ClientScenario {
  name = 'dns-rebinding-protection';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description = `Test DNS rebinding protection for localhost servers.

**Scope:** This test applies to localhost MCP servers running without HTTPS and without
authentication. These servers are vulnerable to DNS rebinding attacks where a malicious
website tricks a user's browser into making requests to the local server.

**Attack scenario:**
1. User visits malicious website (e.g., evil.com)
2. evil.com's DNS is configured to resolve to 127.0.0.1
3. Browser makes request to evil.com which actually goes to localhost
4. Without Host/Origin header validation, the local MCP server processes the request

**Requirements:**
- Server **MUST** validate the Host or Origin header on incoming requests
- Server **MUST** reject requests with non-localhost Host/Origin headers (HTTP 4xx)
- Server **MUST** accept requests with valid localhost Host/Origin headers

**Valid localhost values:** \`localhost\`, \`127.0.0.1\`, \`[::1]\` (with optional port)

**Note:** This test requires a localhost server URL. Non-localhost URLs will fail.

See: https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // Common check properties
    const rejectedCheckBase = {
      id: 'localhost-host-rebinding-rejected',
      name: 'DNSRebindingRejected',
      description:
        'Server rejects requests with non-localhost Host/Origin headers',
      timestamp,
      specReferences: SPEC_REFERENCES
    };

    const acceptedCheckBase = {
      id: 'localhost-host-valid-accepted',
      name: 'LocalhostHostAccepted',
      description:
        'Server accepts requests with valid localhost Host/Origin headers',
      timestamp,
      specReferences: SPEC_REFERENCES
    };

    // First check: Is this a localhost URL?
    if (!isLocalhostUrl(serverUrl)) {
      const errorMessage =
        'DNS rebinding tests require a localhost server URL (localhost, 127.0.0.1, or [::1])';
      const details = { serverUrl, reason: 'non-localhost-url' };

      checks.push({
        ...rejectedCheckBase,
        status: 'FAILURE',
        errorMessage,
        details
      });
      checks.push({
        ...acceptedCheckBase,
        status: 'FAILURE',
        errorMessage,
        details
      });
      return checks;
    }

    const validHost = getHostFromUrl(serverUrl);
    const attackerHost = 'evil.example.com';

    // Check 1: Invalid Host/Origin headers should be rejected with a 4xx error
    try {
      const response = await sendRequestWithHostAndOrigin(
        serverUrl,
        attackerHost,
        specVersion
      );
      const isRejected =
        response.statusCode >= 400 && response.statusCode < 500;

      const details = {
        hostHeader: attackerHost,
        originHeader: `http://${attackerHost}`,
        statusCode: response.statusCode,
        body: response.body
      };

      if (isRejected) {
        checks.push({
          ...rejectedCheckBase,
          status: 'SUCCESS',
          details
        });
      } else {
        checks.push({
          ...rejectedCheckBase,
          status: 'FAILURE',
          errorMessage: `Expected HTTP 4xx for invalid Host/Origin headers, got ${response.statusCode}`,
          details
        });
      }
    } catch (error) {
      checks.push({
        ...rejectedCheckBase,
        status: 'FAILURE',
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          hostHeader: attackerHost,
          originHeader: `http://${attackerHost}`
        }
      });
    }

    // Check 2: Valid localhost Host/Origin headers should be accepted (2xx response)
    try {
      const response = await sendRequestWithHostAndOrigin(
        serverUrl,
        validHost,
        specVersion
      );
      const isAccepted =
        response.statusCode >= 200 && response.statusCode < 300;

      const details: Record<string, unknown> = {
        hostHeader: validHost,
        originHeader: `http://${validHost}`,
        statusCode: response.statusCode,
        body: response.body
      };

      // Lifecycle hygiene (#338): the valid-host probe is a real `initialize`,
      // so complete the handshake (`notifications/initialized`) and release the
      // session. This is best-effort and recorded in `details` only — the
      // Host/Origin check's pass/fail stays keyed to the initialize response so
      // the result remains decidable from this check's spec references.
      const hasInitializeResult =
        typeof response.body === 'object' &&
        response.body !== null &&
        'result' in response.body &&
        !('error' in response.body);
      if (isAccepted && hasInitializeResult && isStatefulVersion(specVersion)) {
        try {
          const initialized = await sendInitializedNotification(
            serverUrl,
            validHost,
            specVersion,
            response.sessionId
          );
          details.initializedNotification = {
            statusCode: initialized.statusCode,
            body: initialized.body,
            sessionIdSent: response.sessionId !== undefined
          };
          if (response.sessionId) {
            await request(serverUrl, {
              method: 'DELETE',
              headers: {
                'Mcp-Session-Id': response.sessionId,
                'MCP-Protocol-Version': specVersion
              }
            }).catch(() => {});
          }
        } catch (error) {
          details.initializedNotification = {
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      if (isAccepted) {
        checks.push({
          ...acceptedCheckBase,
          status: 'SUCCESS',
          details
        });
      } else {
        checks.push({
          ...acceptedCheckBase,
          status: 'FAILURE',
          errorMessage: `Expected HTTP 2xx for valid localhost Host/Origin headers, got ${response.statusCode}`,
          details
        });
      }
    } catch (error) {
      checks.push({
        ...acceptedCheckBase,
        status: 'FAILURE',
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { hostHeader: validHost, originHeader: `http://${validHost}` }
      });
    }

    return checks;
  }
}
