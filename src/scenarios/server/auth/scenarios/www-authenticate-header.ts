/**
 * WWW-Authenticate Header Validation Scenario
 *
 * Tests that an OAuth-protected MCP server returns properly formatted
 * WWW-Authenticate headers in 401 responses.
 *
 * @see RFC 6750 - Bearer Token Usage
 * @see RFC 7235 - HTTP Authentication
 * @see MCP Authorization Specification
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { authFetch } from '../helpers/auth-fetch';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates WWW-Authenticate header format and content.
 *
 * Per RFC 6750 Section 3:
 * - MUST use "Bearer" authentication scheme
 * - MAY include "realm" parameter
 * - MAY include "scope" parameter (space-separated scope values)
 * - MAY include "error" parameter for error responses
 * - MAY include "error_description" parameter
 *
 * MCP extends this with:
 * - "resource_metadata" parameter pointing to PRM URL
 */
export class AuthWWWAuthenticateHeaderScenario implements ClientScenario {
  name = 'server/auth-www-authenticate-header';
  description = `Test WWW-Authenticate header format in 401 responses.

**Server Implementation Requirements:**

**Header Format**: Bearer challenge per RFC 6750

**Required**:
- Use "Bearer" authentication scheme

**Recommended**:
- Include \`resource_metadata\` parameter with PRM URL
- Include \`scope\` parameter if scopes are required

**Optional**:
- Include \`realm\` parameter
- Include \`error\` parameter for specific error conditions
- Include \`error_description\` for human-readable error details

**Example Headers**:
\`\`\`
WWW-Authenticate: Bearer realm="mcp"
WWW-Authenticate: Bearer scope="mcp:read mcp:write", resource_metadata="https://server.example.com/.well-known/oauth-protected-resource"
WWW-Authenticate: Bearer error="invalid_token", error_description="Token expired"
\`\`\`

**Spec References**:
- RFC 6750 Section 3 (WWW-Authenticate Response Header)
- RFC 7235 Section 4.1 (WWW-Authenticate)
- MCP Authorization - Scope Selection Strategy`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Make unauthenticated request to trigger 401
    const jsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1
    };

    let response: Awaited<ReturnType<typeof authFetch>>;

    try {
      response = await authFetch(serverUrl, {
        method: 'POST',
        body: jsonRpcRequest
      });
    } catch (error) {
      checks.push({
        id: 'auth-www-auth-request-completes',
        name: 'Request Completes',
        description: 'Server responds to request',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE]
      });
      return checks;
    }

    // If not 401, we can't test WWW-Authenticate
    if (response.status !== 401) {
      // Try initialize first to establish session, then tools/list
      const initRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'conformance-test', version: '1.0.0' }
        },
        id: 0
      };

      try {
        await authFetch(serverUrl, { method: 'POST', body: initRequest });
        response = await authFetch(serverUrl, {
          method: 'POST',
          body: jsonRpcRequest
        });
      } catch {
        // Continue with original response
      }
    }

    if (response.status !== 401) {
      checks.push({
        id: 'auth-www-auth-401-received',
        name: '401 Response Received',
        description: 'Server returned 401 to test WWW-Authenticate header',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: `Server returned ${response.status}, not 401 - cannot test WWW-Authenticate`,
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
        details: {
          status: response.status,
          note: 'Server may not require authentication or may allow this method without auth'
        }
      });
      return checks;
    }

    // Check 1: WWW-Authenticate header exists
    if (!response.wwwAuthenticate) {
      checks.push({
        id: 'auth-www-auth-header-exists',
        name: 'WWW-Authenticate Header Exists',
        description: '401 response includes WWW-Authenticate header',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing WWW-Authenticate header in 401 response',
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE,
          ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
        ]
      });
      return checks;
    }

    checks.push({
      id: 'auth-www-auth-header-exists',
      name: 'WWW-Authenticate Header Exists',
      description: '401 response includes WWW-Authenticate header',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE,
        ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
      ],
      details: {
        raw: response.wwwAuthenticate.raw
      }
    });

    const wwwAuth = response.wwwAuthenticate;

    // Check 2: Uses Bearer scheme
    if (wwwAuth.scheme.toLowerCase() === 'bearer') {
      checks.push({
        id: 'auth-www-auth-bearer-scheme',
        name: 'Bearer Scheme Used',
        description: 'WWW-Authenticate uses Bearer authentication scheme',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
        details: {
          scheme: wwwAuth.scheme
        }
      });
    } else {
      checks.push({
        id: 'auth-www-auth-bearer-scheme',
        name: 'Bearer Scheme Used',
        description: 'WWW-Authenticate uses Bearer authentication scheme',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Expected "Bearer" scheme, got "${wwwAuth.scheme}"`,
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
        details: {
          scheme: wwwAuth.scheme,
          expected: 'Bearer'
        }
      });
    }

    // Check 3: resource_metadata parameter (recommended for MCP)
    if (wwwAuth.params.resource_metadata) {
      // Validate it's a valid URL
      try {
        new URL(wwwAuth.params.resource_metadata);
        checks.push({
          id: 'auth-www-auth-resource-metadata',
          name: 'Resource Metadata URL',
          description: 'WWW-Authenticate includes valid resource_metadata URL',
          status: 'SUCCESS',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.MCP_AUTH_SCOPE_SELECTION],
          details: {
            resource_metadata: wwwAuth.params.resource_metadata
          }
        });
      } catch {
        checks.push({
          id: 'auth-www-auth-resource-metadata',
          name: 'Resource Metadata URL',
          description: 'WWW-Authenticate includes valid resource_metadata URL',
          status: 'FAILURE',
          timestamp: timestamp(),
          errorMessage: `Invalid resource_metadata URL: ${wwwAuth.params.resource_metadata}`,
          specReferences: [ServerAuthSpecReferences.MCP_AUTH_SCOPE_SELECTION],
          details: {
            resource_metadata: wwwAuth.params.resource_metadata
          }
        });
      }
    } else {
      checks.push({
        id: 'auth-www-auth-resource-metadata',
        name: 'Resource Metadata URL',
        description:
          'WWW-Authenticate includes resource_metadata URL (recommended)',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage:
          'Missing resource_metadata parameter (recommended for MCP)',
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_SCOPE_SELECTION],
        details: {
          params: wwwAuth.params
        }
      });
    }

    // Check 4: scope parameter format (if present)
    if (wwwAuth.params.scope !== undefined) {
      const scope = wwwAuth.params.scope;

      // Scope should be space-separated tokens per RFC 6749
      // Each scope token should be printable ASCII without certain characters
      const scopeTokenRegex = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
      const scopes = scope.split(' ').filter((s) => s.length > 0);

      if (scopes.length === 0 && scope.length > 0) {
        checks.push({
          id: 'auth-www-auth-scope-format',
          name: 'Scope Parameter Format',
          description: 'Scope parameter is properly formatted',
          status: 'WARNING',
          timestamp: timestamp(),
          errorMessage: 'Scope parameter is present but empty or malformed',
          specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
          details: {
            scope,
            parsed: scopes
          }
        });
      } else {
        const invalidScopes = scopes.filter((s) => !scopeTokenRegex.test(s));
        if (invalidScopes.length > 0) {
          checks.push({
            id: 'auth-www-auth-scope-format',
            name: 'Scope Parameter Format',
            description: 'Scope parameter contains valid scope tokens',
            status: 'WARNING',
            timestamp: timestamp(),
            errorMessage: `Some scope tokens may contain invalid characters: ${invalidScopes.join(', ')}`,
            specReferences: [
              ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
            ],
            details: {
              scope,
              scopes,
              invalidScopes
            }
          });
        } else {
          checks.push({
            id: 'auth-www-auth-scope-format',
            name: 'Scope Parameter Format',
            description: 'Scope parameter is properly formatted',
            status: 'SUCCESS',
            timestamp: timestamp(),
            specReferences: [
              ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
            ],
            details: {
              scope,
              scopes
            }
          });
        }
      }
    }

    // Check 5: error parameter (if present, validate it's a known value)
    if (wwwAuth.params.error !== undefined) {
      const validErrors = [
        'invalid_request',
        'invalid_token',
        'insufficient_scope'
      ];

      if (validErrors.includes(wwwAuth.params.error)) {
        checks.push({
          id: 'auth-www-auth-error-code',
          name: 'Error Code Valid',
          description: 'Error parameter uses RFC 6750 defined value',
          status: 'SUCCESS',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_6750_ERROR_CODES],
          details: {
            error: wwwAuth.params.error,
            error_description: wwwAuth.params.error_description
          }
        });
      } else {
        checks.push({
          id: 'auth-www-auth-error-code',
          name: 'Error Code Valid',
          description: 'Error parameter uses RFC 6750 defined value',
          status: 'WARNING',
          timestamp: timestamp(),
          errorMessage: `Unknown error code: ${wwwAuth.params.error}`,
          specReferences: [ServerAuthSpecReferences.RFC_6750_ERROR_CODES],
          details: {
            error: wwwAuth.params.error,
            validErrors,
            note: 'Custom error codes are allowed but not standard'
          }
        });
      }
    }

    return checks;
  }
}
