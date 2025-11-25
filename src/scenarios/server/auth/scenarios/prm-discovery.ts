/**
 * Protected Resource Metadata (PRM) Discovery Scenario
 *
 * Tests that an OAuth-protected MCP server correctly exposes its
 * Protected Resource Metadata at the well-known endpoint.
 *
 * @see RFC 9728 - OAuth 2.0 Protected Resource Metadata
 * @see MCP Authorization Specification
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { authFetch, buildPrmUrl } from '../helpers/auth-fetch';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates Protected Resource Metadata endpoint.
 *
 * Per RFC 9728, the PRM document:
 * - MUST be served at /.well-known/oauth-protected-resource or path-based variant
 * - MUST be valid JSON with Content-Type: application/json
 * - MUST contain "resource" field (the protected resource identifier)
 * - MUST contain "authorization_servers" array (list of AS URLs)
 * - MAY contain "scopes_supported" array
 */
export class AuthPrmDiscoveryScenario implements ClientScenario {
  name = 'server/auth-prm-discovery';
  description = `Test Protected Resource Metadata (PRM) discovery endpoint.

**Server Implementation Requirements:**

**Endpoint**: \`/.well-known/oauth-protected-resource\` or path-based variant

**Requirements**:
- Return HTTP 200 with Content-Type: application/json
- Include required \`resource\` field (protected resource identifier)
- Include required \`authorization_servers\` array (authorization server URLs)
- Optional \`scopes_supported\` array if scopes are defined

**Example Response**:
\`\`\`json
{
  "resource": "https://server.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["mcp:read", "mcp:write"]
}
\`\`\`

**Spec References**:
- RFC 9728 Section 3.1 (Discovery)
- RFC 9728 Section 3.2 (Response)
- MCP Authorization - Protected Resource Metadata`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Try path-based PRM first (more specific), then fall back to root
    const pathBasedUrl = buildPrmUrl(serverUrl, true);
    const rootUrl = buildPrmUrl(serverUrl, false);

    let prmResponse: Awaited<ReturnType<typeof authFetch>> | null = null;
    let usedUrl = '';

    // Try path-based first
    try {
      const response = await authFetch(pathBasedUrl);
      if (response.status === 200) {
        prmResponse = response;
        usedUrl = pathBasedUrl;
      }
    } catch {
      // Path-based failed, will try root
    }

    // Try root if path-based didn't work
    if (!prmResponse && pathBasedUrl !== rootUrl) {
      try {
        const response = await authFetch(rootUrl);
        if (response.status === 200) {
          prmResponse = response;
          usedUrl = rootUrl;
        }
      } catch {
        // Root also failed
      }
    }

    // Check 1: PRM endpoint exists
    if (!prmResponse) {
      checks.push({
        id: 'auth-prm-endpoint-exists',
        name: 'PRM Endpoint Exists',
        description: 'Server exposes Protected Resource Metadata at well-known endpoint',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `No PRM found at ${pathBasedUrl} or ${rootUrl}`,
        specReferences: [
          ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_SERVER_LOCATION
        ],
        details: {
          triedUrls: [pathBasedUrl, rootUrl]
        }
      });
      return checks;
    }

    checks.push({
      id: 'auth-prm-endpoint-exists',
      name: 'PRM Endpoint Exists',
      description: 'Server exposes Protected Resource Metadata at well-known endpoint',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY,
        ServerAuthSpecReferences.MCP_AUTH_PRM_DISCOVERY
      ],
      details: {
        url: usedUrl,
        status: prmResponse.status
      }
    });

    // Check 2: Response is valid JSON
    const body = prmResponse.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      checks.push({
        id: 'auth-prm-valid-json',
        name: 'PRM Valid JSON',
        description: 'PRM response is a valid JSON object',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Response is not a JSON object',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
        details: {
          rawBody: prmResponse.rawBody.substring(0, 500)
        }
      });
      return checks;
    }

    checks.push({
      id: 'auth-prm-valid-json',
      name: 'PRM Valid JSON',
      description: 'PRM response is a valid JSON object',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE]
    });

    const prm = body as Record<string, unknown>;

    // Check 3: Required "resource" field
    if (typeof prm.resource !== 'string' || prm.resource.length === 0) {
      checks.push({
        id: 'auth-prm-has-resource',
        name: 'PRM Has Resource Field',
        description: 'PRM contains required "resource" identifier',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing or invalid "resource" field (must be non-empty string)',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
        details: {
          resource: prm.resource
        }
      });
    } else {
      checks.push({
        id: 'auth-prm-has-resource',
        name: 'PRM Has Resource Field',
        description: 'PRM contains required "resource" identifier',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
        details: {
          resource: prm.resource
        }
      });
    }

    // Check 4: Required "authorization_servers" field
    if (!Array.isArray(prm.authorization_servers) || prm.authorization_servers.length === 0) {
      checks.push({
        id: 'auth-prm-has-authorization-servers',
        name: 'PRM Has Authorization Servers',
        description: 'PRM contains required "authorization_servers" array',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing or invalid "authorization_servers" field (must be non-empty array)',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
        details: {
          authorization_servers: prm.authorization_servers
        }
      });
    } else {
      // Validate each URL in the array
      const invalidUrls: string[] = [];
      for (const server of prm.authorization_servers) {
        if (typeof server !== 'string') {
          invalidUrls.push(String(server));
          continue;
        }
        try {
          new URL(server);
        } catch {
          invalidUrls.push(server);
        }
      }

      if (invalidUrls.length > 0) {
        checks.push({
          id: 'auth-prm-has-authorization-servers',
          name: 'PRM Has Authorization Servers',
          description: 'PRM contains required "authorization_servers" array with valid URLs',
          status: 'FAILURE',
          timestamp: timestamp(),
          errorMessage: `Invalid URLs in authorization_servers: ${invalidUrls.join(', ')}`,
          specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
          details: {
            authorization_servers: prm.authorization_servers,
            invalidUrls
          }
        });
      } else {
        checks.push({
          id: 'auth-prm-has-authorization-servers',
          name: 'PRM Has Authorization Servers',
          description: 'PRM contains required "authorization_servers" array with valid URLs',
          status: 'SUCCESS',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
          details: {
            authorization_servers: prm.authorization_servers
          }
        });
      }
    }

    // Check 5: Optional "scopes_supported" validation (if present)
    if (prm.scopes_supported !== undefined) {
      if (!Array.isArray(prm.scopes_supported)) {
        checks.push({
          id: 'auth-prm-scopes-supported-valid',
          name: 'PRM Scopes Supported Valid',
          description: 'PRM "scopes_supported" field is a valid array (if present)',
          status: 'FAILURE',
          timestamp: timestamp(),
          errorMessage: '"scopes_supported" must be an array when present',
          specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
          details: {
            scopes_supported: prm.scopes_supported
          }
        });
      } else {
        // Check all scopes are strings
        const nonStringScopes = prm.scopes_supported.filter(s => typeof s !== 'string');
        if (nonStringScopes.length > 0) {
          checks.push({
            id: 'auth-prm-scopes-supported-valid',
            name: 'PRM Scopes Supported Valid',
            description: 'PRM "scopes_supported" contains only string values',
            status: 'WARNING',
            timestamp: timestamp(),
            errorMessage: 'Some scopes are not strings',
            specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
            details: {
              scopes_supported: prm.scopes_supported,
              nonStringScopes
            }
          });
        } else {
          checks.push({
            id: 'auth-prm-scopes-supported-valid',
            name: 'PRM Scopes Supported Valid',
            description: 'PRM "scopes_supported" field is valid',
            status: 'SUCCESS',
            timestamp: timestamp(),
            specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
            details: {
              scopes_supported: prm.scopes_supported
            }
          });
        }
      }
    }

    return checks;
  }
}
