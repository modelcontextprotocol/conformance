/**
 * Unauthorized Response (401) Scenario
 *
 * Tests that an OAuth-protected MCP server correctly returns 401 Unauthorized
 * when requests are made without a Bearer token.
 *
 * @see RFC 6750 - Bearer Token Usage
 * @see RFC 7235 - HTTP Authentication
 * @see MCP Authorization Specification
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { authFetch } from '../helpers/auth-fetch';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates server returns 401 for unauthenticated requests.
 *
 * Per RFC 6750 and MCP Authorization spec:
 * - Protected endpoints MUST return 401 when no Authorization header is provided
 * - Response MUST include WWW-Authenticate header with Bearer scheme
 * - Response body SHOULD be valid JSON (either JSON-RPC error or OAuth error)
 */
export class AuthUnauthorizedResponseScenario implements ClientScenario {
  name = 'server/auth-401-unauthorized';
  description = `Test that server returns 401 Unauthorized for unauthenticated requests.

**Server Implementation Requirements:**

**Behavior**: When a request is made without an Authorization header:
- Return HTTP 401 Unauthorized status code
- Include WWW-Authenticate header with Bearer scheme
- Return valid JSON response body

**Expected Response**:
- Status: 401
- Headers: WWW-Authenticate: Bearer ...
- Body: JSON (OAuth error or JSON-RPC error format)

**Example WWW-Authenticate**:
\`\`\`
WWW-Authenticate: Bearer realm="mcp", scope="mcp:read mcp:write"
\`\`\`

**Spec References**:
- RFC 6750 Section 3 (WWW-Authenticate Response Header)
- RFC 7235 Section 3.1 (401 Unauthorized)
- MCP Authorization - Access Token Usage`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Make a request to the MCP endpoint without Authorization header
    // We'll send a minimal JSON-RPC request to trigger auth check
    const jsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'conformance-auth-test',
          version: '1.0.0'
        }
      },
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
        id: 'auth-401-request-completes',
        name: 'Auth Request Completes',
        description: 'Server responds to unauthenticated request',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [ServerAuthSpecReferences.RFC_7235_401_RESPONSE]
      });
      return checks;
    }

    // Check 1: Server returns 401 status
    if (response.status === 401) {
      checks.push({
        id: 'auth-401-status-code',
        name: '401 Status Code',
        description: 'Server returns 401 Unauthorized for unauthenticated requests',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_401_RESPONSE,
          ServerAuthSpecReferences.RFC_6750_BEARER_TOKEN
        ],
        details: {
          status: response.status
        }
      });
    } else if (response.status === 200) {
      // Server might allow unauthenticated initialize but protect other methods
      // This is acceptable per MCP spec (step-up auth)
      checks.push({
        id: 'auth-401-status-code',
        name: '401 Status Code',
        description: 'Server returns 401 Unauthorized for unauthenticated requests',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'Server allowed unauthenticated request (may use step-up auth)',
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_401_RESPONSE,
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN
        ],
        details: {
          status: response.status,
          note: 'Server may allow initialize without auth and protect other methods'
        }
      });

      // If server allows initialize, try tools/list which typically requires auth
      try {
        const toolsRequest = {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 2
        };

        const toolsResponse = await authFetch(serverUrl, {
          method: 'POST',
          body: toolsRequest
        });

        if (toolsResponse.status === 401) {
          checks.push({
            id: 'auth-401-protected-method',
            name: '401 For Protected Method',
            description: 'Server returns 401 for protected methods (step-up auth)',
            status: 'SUCCESS',
            timestamp: timestamp(),
            specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN],
            details: {
              method: 'tools/list',
              status: toolsResponse.status
            }
          });
          // Use this response for further checks
          response = toolsResponse;
        } else {
          checks.push({
            id: 'auth-401-protected-method',
            name: '401 For Protected Method',
            description: 'Server returns 401 for protected methods',
            status: 'WARNING',
            timestamp: timestamp(),
            errorMessage: `tools/list returned ${toolsResponse.status}, not 401`,
            specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN],
            details: {
              method: 'tools/list',
              status: toolsResponse.status
            }
          });
        }
      } catch {
        // tools/list request failed, continue with original response
      }
    } else {
      checks.push({
        id: 'auth-401-status-code',
        name: '401 Status Code',
        description: 'Server returns 401 Unauthorized for unauthenticated requests',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Expected 401, got ${response.status}`,
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_401_RESPONSE,
          ServerAuthSpecReferences.RFC_6750_BEARER_TOKEN
        ],
        details: {
          status: response.status,
          body: response.body
        }
      });
    }

    // Check 2: WWW-Authenticate header is present
    if (response.wwwAuthenticate) {
      checks.push({
        id: 'auth-401-www-authenticate-present',
        name: 'WWW-Authenticate Header Present',
        description: '401 response includes WWW-Authenticate header',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE,
          ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
        ],
        details: {
          wwwAuthenticate: response.wwwAuthenticate.raw
        }
      });
    } else if (response.status === 401) {
      checks.push({
        id: 'auth-401-www-authenticate-present',
        name: 'WWW-Authenticate Header Present',
        description: '401 response includes WWW-Authenticate header',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: '401 response missing required WWW-Authenticate header',
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE,
          ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE
        ]
      });
    }

    // Check 3: Response body is valid JSON
    if (typeof response.body === 'object' && response.body !== null) {
      checks.push({
        id: 'auth-401-response-json',
        name: 'Response Is JSON',
        description: '401 response body is valid JSON',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ERROR_HANDLING],
        details: {
          bodyType: Array.isArray(response.body) ? 'array' : 'object'
        }
      });
    } else if (response.status === 401) {
      checks.push({
        id: 'auth-401-response-json',
        name: 'Response Is JSON',
        description: '401 response body is valid JSON',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'Response body is not valid JSON',
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ERROR_HANDLING],
        details: {
          rawBody: response.rawBody.substring(0, 200)
        }
      });
    }

    return checks;
  }
}
