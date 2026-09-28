/**
 * DNS Rebinding Protection test scenarios for MCP servers
 *
 * Tests that localhost MCP servers properly validate Host and Origin headers
 * to prevent DNS rebinding attacks. See GHSA-w48q-cv73-mx4w for details.
 */

import {
  CheckStatus,
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import { buildStandardHeaders, type RunContext } from '../../connection';
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
 * Expectations for the Host-only and Origin-only checks. They depend on
 * spec text that modelcontextprotocol/modelcontextprotocol#3370 proposes to
 * change, so they live here and nowhere else.
 *
 * Origin: the Streamable HTTP transport ("Security Warning" in 2025-11-25,
 * "Security & Endpoint" in the draft) says "Servers MUST validate the Origin
 * header on all incoming connections to prevent DNS rebinding attacks. If the
 * Origin header is present and invalid, servers MUST respond with HTTP 403
 * Forbidden." MUST, so a miss is FAILURE, and the status must be exactly 403.
 *
 * Host: no spec text requires Host validation. The check follows the SDK
 * advisories (GHSA-w48q-cv73-mx4w, GHSA-9h52-p55h-vw2f), whose fix is Host
 * validation on localhost, and accepts any 4xx. With no MUST behind it, a
 * miss is WARNING.
 */
const ORIGIN_ONLY_EXPECTED_STATUS = 403;
const ORIGIN_ONLY_MISS_STATUS: CheckStatus = 'FAILURE';
const HOST_ONLY_MISS_STATUS: CheckStatus = 'WARNING';

const ORIGIN_ONLY_SPEC_REFERENCES = [
  {
    id: 'MCP-Transport-Security',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning'
  },
  {
    id: 'MCP-Transport-Security-Draft',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http#security-%26-endpoint'
  }
];

const HOST_ONLY_SPEC_REFERENCES = [
  ...SPEC_REFERENCES,
  {
    id: 'GHSA-w48q-cv73-mx4w',
    url: 'https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w'
  },
  {
    id: 'GHSA-9h52-p55h-vw2f',
    url: 'https://github.com/modelcontextprotocol/python-sdk/security/advisories/GHSA-9h52-p55h-vw2f'
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

function getResponseHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
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
  return sendProbe(serverUrl, specVersion, {
    host: hostOrOrigin,
    origin: `http://${hostOrOrigin}`
  });
}

/**
 * Send the probe request with the given Host header and, when set, the given
 * Origin header. With `origin` unset no Origin header is sent.
 */
async function sendProbe(
  serverUrl: string,
  specVersion: string,
  { host, origin }: { host: string; origin?: string }
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
        Host: host,
        ...(origin !== undefined ? { Origin: origin } : {}),
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

  return {
    statusCode: response.statusCode,
    body,
    sessionId: getResponseHeader(response.headers, 'mcp-session-id')
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

**Checks:**
- \`localhost-host-rebinding-rejected\`: Host and Origin both non-localhost. Expects HTTP 4xx.
  A server that validates either header passes.
- \`localhost-host-only-rebinding-rejected\`: non-localhost Host, no Origin. Expects HTTP 4xx.
  No spec text requires Host validation, so a miss is a WARNING.
- \`localhost-origin-only-rebinding-rejected\`: localhost Host, non-localhost Origin. The
  transport spec says: if the Origin header is present and invalid, servers **MUST** respond
  with HTTP 403 Forbidden. Expects exactly 403.
- \`localhost-host-valid-accepted\`: localhost Host and Origin. Expects HTTP 2xx.

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

    const hostOnlyCheckBase = {
      id: 'localhost-host-only-rebinding-rejected',
      name: 'DNSRebindingHostOnlyRejected',
      description:
        'Server rejects a request with a non-localhost Host header and no Origin header',
      timestamp,
      specReferences: HOST_ONLY_SPEC_REFERENCES
    };

    const originOnlyCheckBase = {
      id: 'localhost-origin-only-rebinding-rejected',
      name: 'DNSRebindingOriginOnlyRejected',
      description: `Server responds ${ORIGIN_ONLY_EXPECTED_STATUS} to a request with a localhost Host header and a non-localhost Origin header`,
      timestamp,
      specReferences: ORIGIN_ONLY_SPEC_REFERENCES
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
        ...hostOnlyCheckBase,
        status: HOST_ONLY_MISS_STATUS,
        errorMessage,
        details
      });
      checks.push({
        ...originOnlyCheckBase,
        status: ORIGIN_ONLY_MISS_STATUS,
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

    // Check 2: A non-localhost Host with no Origin should be rejected with a 4xx
    try {
      const response = await sendProbe(serverUrl, specVersion, {
        host: attackerHost
      });
      const isRejected =
        response.statusCode >= 400 && response.statusCode < 500;

      const details = {
        hostHeader: attackerHost,
        originHeader: null,
        statusCode: response.statusCode,
        body: response.body
      };

      if (isRejected) {
        checks.push({
          ...hostOnlyCheckBase,
          status: 'SUCCESS',
          details
        });
      } else {
        checks.push({
          ...hostOnlyCheckBase,
          status: HOST_ONLY_MISS_STATUS,
          errorMessage: `Expected HTTP 4xx for a non-localhost Host header with no Origin header, got ${response.statusCode}`,
          details
        });
      }
    } catch (error) {
      checks.push({
        ...hostOnlyCheckBase,
        status: HOST_ONLY_MISS_STATUS,
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { hostHeader: attackerHost, originHeader: null }
      });
    }

    // Check 3: A localhost Host with a non-localhost Origin should get a 403
    const attackerOrigin = `http://${attackerHost}`;
    try {
      const response = await sendProbe(serverUrl, specVersion, {
        host: validHost,
        origin: attackerOrigin
      });

      const details = {
        hostHeader: validHost,
        originHeader: attackerOrigin,
        statusCode: response.statusCode,
        body: response.body
      };

      if (response.statusCode === ORIGIN_ONLY_EXPECTED_STATUS) {
        checks.push({
          ...originOnlyCheckBase,
          status: 'SUCCESS',
          details
        });
      } else {
        checks.push({
          ...originOnlyCheckBase,
          status: ORIGIN_ONLY_MISS_STATUS,
          errorMessage: `Expected HTTP ${ORIGIN_ONLY_EXPECTED_STATUS} for a non-localhost Origin header, got ${response.statusCode}`,
          details
        });
      }
    } catch (error) {
      checks.push({
        ...originOnlyCheckBase,
        status: ORIGIN_ONLY_MISS_STATUS,
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { hostHeader: validHost, originHeader: attackerOrigin }
      });
    }

    // Check 4: Valid localhost Host/Origin headers should be accepted (2xx response)
    try {
      const response = await sendRequestWithHostAndOrigin(
        serverUrl,
        validHost,
        specVersion
      );
      const isAccepted =
        response.statusCode >= 200 && response.statusCode < 300;
      const initializedNotification =
        isAccepted && specVersion !== DRAFT_PROTOCOL_VERSION
          ? await sendInitializedNotification(
              serverUrl,
              validHost,
              specVersion,
              response.sessionId
            )
          : undefined;
      const initializedAccepted =
        !initializedNotification ||
        (initializedNotification.statusCode >= 200 &&
          initializedNotification.statusCode < 300);

      const details = {
        hostHeader: validHost,
        originHeader: `http://${validHost}`,
        statusCode: response.statusCode,
        body: response.body,
        ...(initializedNotification
          ? {
              initializedNotification: {
                statusCode: initializedNotification.statusCode,
                body: initializedNotification.body,
                sessionIdSent: response.sessionId ?? null
              }
            }
          : {})
      };

      if (isAccepted && initializedAccepted) {
        checks.push({
          ...acceptedCheckBase,
          status: 'SUCCESS',
          details
        });
      } else {
        const errorMessage = !isAccepted
          ? `Expected HTTP 2xx for valid localhost Host/Origin headers, got ${response.statusCode}`
          : `Expected HTTP 2xx for initialized notification after valid localhost initialize, got ${initializedNotification?.statusCode}`;
        checks.push({
          ...acceptedCheckBase,
          status: 'FAILURE',
          errorMessage,
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
