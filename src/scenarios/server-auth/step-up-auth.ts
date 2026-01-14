/**
 * Step-Up Authentication Scenario
 *
 * Tests that an MCP server correctly handles step-up authentication:
 * 1. Initial request with basic scope succeeds for tools/list
 * 2. Request to privileged tool returns 403 with insufficient_scope
 * 3. WWW-Authenticate header includes required scope
 * 4. After re-auth with elevated scope, privileged tool succeeds
 *
 * This tests RFC 6750 Section 3 (insufficient_scope error) and
 * MCP's scope escalation requirements.
 */

import type { ClientScenario, ConformanceCheck } from '../../types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { applyMiddlewares } from '@modelcontextprotocol/sdk/client/middleware.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ConformanceOAuthProvider,
  createObservationMiddleware,
  type ObservedRequest
} from './helpers/oauth-client';
import { ServerAuthSpecReferences } from './spec-references';

/**
 * Step-Up Auth Scenario - Tests 403 insufficient_scope handling.
 */
export class StepUpAuthScenario implements ClientScenario {
  name = 'server-auth/step-up-auth';
  description = `Tests step-up authentication where a privileged tool requires additional scopes.

**Flow tested:**
1. Authenticate with basic scope
2. Call tools/list (should succeed)
3. Call privileged tool (should get 403 insufficient_scope)
4. Re-authenticate with elevated scope (admin)
5. Call privileged tool again (should succeed)

**Spec References:**
- RFC 6750 Section 3 (insufficient_scope error)
- MCP Authorization Specification (scope handling)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const observedRequests: ObservedRequest[] = [];
    const timestamp = () => new Date().toISOString();

    // Create observation middleware to record all requests
    const observationMiddleware = createObservationMiddleware((req) => {
      observedRequests.push(req);
    });

    // Track auth attempts
    let authAttempts = 0;

    // Create OAuth provider for conformance testing
    const provider = new ConformanceOAuthProvider(
      'http://localhost:3000/callback',
      {
        client_name: 'MCP Conformance Step-Up Test Client',
        redirect_uris: ['http://localhost:3000/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post'
      }
    );

    // Handle 401/403 with OAuth flow
    const handleAuthChallenge = async (
      response: Response,
      next: FetchLike,
      url: string
    ): Promise<void> => {
      authAttempts++;
      const { resourceMetadataUrl, scope } =
        extractWWWAuthenticateParams(response);

      let result = await auth(provider, {
        serverUrl: url,
        resourceMetadataUrl,
        scope,
        fetchFn: next
      });

      if (result === 'REDIRECT') {
        const authorizationCode = await provider.getAuthCode();

        result = await auth(provider, {
          serverUrl: url,
          resourceMetadataUrl,
          scope,
          authorizationCode,
          fetchFn: next
        });

        if (result !== 'AUTHORIZED') {
          throw new UnauthorizedError(
            `Authentication failed with result: ${result}`
          );
        }
      }
    };

    // Create middleware that handles OAuth with observation
    const oauthMiddleware = (next: FetchLike): FetchLike => {
      return async (input, init) => {
        const headers = new Headers(init?.headers);
        const tokens = await provider.tokens();
        if (tokens) {
          headers.set('Authorization', `Bearer ${tokens.access_token}`);
        }

        const response = await next(input, { ...init, headers });

        // Handle 401 (no auth) or 403 (insufficient scope)
        if (response.status === 401 || response.status === 403) {
          const url = typeof input === 'string' ? input : input.toString();
          await handleAuthChallenge(response.clone(), next, url);
          // Retry with fresh tokens
          const newTokens = await provider.tokens();
          if (newTokens) {
            headers.set('Authorization', `Bearer ${newTokens.access_token}`);
          }
          return await next(input, { ...init, headers });
        }

        return response;
      };
    };

    // Compose middlewares
    const enhancedFetch = applyMiddlewares(
      observationMiddleware,
      oauthMiddleware
    )(fetch);

    try {
      // Create MCP client
      const client = new Client(
        { name: 'conformance-step-up-test-client', version: '1.0.0' },
        { capabilities: {} }
      );

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: enhancedFetch
      });

      // Connect triggers initial OAuth flow
      await client.connect(transport);

      // Step 1: List tools (should work with basic auth)
      try {
        await client.listTools();
      } catch {
        // May fail if server requires scope for listTools too
      }

      // Step 2: Try to call a privileged tool (should trigger 403 -> re-auth)
      let got403 = false;

      try {
        // Look for a tool that requires admin scope
        // Common patterns: admin-*, privileged-*, or specific tool names
        await client.callTool({ name: 'admin-action', arguments: {} });
      } catch {
        // Check if we observed a 403 response
        got403 = observedRequests.some(
          (r) =>
            r.responseStatus === 403 &&
            r.wwwAuthenticate?.params?.error === 'insufficient_scope'
        );
      }

      await transport.close();

      // Analyze results
      this.analyzeRequests(
        observedRequests,
        checks,
        timestamp,
        got403,
        authAttempts
      );
    } catch (error) {
      // Analyze what we observed before the error
      this.analyzeRequests(
        observedRequests,
        checks,
        timestamp,
        observedRequests.some((r) => r.responseStatus === 403),
        authAttempts
      );

      checks.push({
        id: 'step-up-auth-flow',
        name: 'Step-Up Auth Flow Completion',
        description: 'Step-up authentication flow',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE]
      });
    }

    return checks;
  }

  /**
   * Analyze observed requests and generate conformance checks.
   */
  private analyzeRequests(
    requests: ObservedRequest[],
    checks: ConformanceCheck[],
    timestamp: () => string,
    got403: boolean,
    authAttempts: number
  ): void {
    // Check 1: Server returns 403 for insufficient scope
    const insufficientScopeResponse = requests.find(
      (r) =>
        r.responseStatus === 403 &&
        r.wwwAuthenticate?.params?.error === 'insufficient_scope'
    );

    if (insufficientScopeResponse) {
      checks.push({
        id: 'step-up-403-response',
        name: 'Server Returns 403 for Insufficient Scope',
        description:
          'Server correctly returns 403 with insufficient_scope error',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
        details: {
          url: insufficientScopeResponse.url,
          wwwAuthenticate: insufficientScopeResponse.wwwAuthenticate
        }
      });

      // Check 2: WWW-Authenticate includes scope parameter
      const scopeInHeader =
        insufficientScopeResponse.wwwAuthenticate?.params?.scope;
      checks.push({
        id: 'step-up-scope-in-header',
        name: 'WWW-Authenticate Includes Required Scope',
        description: scopeInHeader
          ? 'Server includes scope parameter in WWW-Authenticate header'
          : 'Server SHOULD include scope parameter in WWW-Authenticate header',
        status: scopeInHeader ? 'SUCCESS' : 'WARNING',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
        details: {
          scope: scopeInHeader || 'not provided'
        }
      });

      // Check 3: WWW-Authenticate includes resource_metadata
      const resourceMetadata =
        insufficientScopeResponse.wwwAuthenticate?.params?.resource_metadata;
      checks.push({
        id: 'step-up-resource-metadata',
        name: 'WWW-Authenticate Includes Resource Metadata',
        description: resourceMetadata
          ? 'Server includes resource_metadata in WWW-Authenticate header'
          : 'Server SHOULD include resource_metadata in WWW-Authenticate header',
        status: resourceMetadata ? 'SUCCESS' : 'INFO',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_9728_WWW_AUTHENTICATE],
        details: {
          resourceMetadata: resourceMetadata || 'not provided'
        }
      });
    } else if (got403) {
      // Got 403 but without proper insufficient_scope error
      checks.push({
        id: 'step-up-403-response',
        name: 'Server Returns 403 for Insufficient Scope',
        description:
          'Server returned 403 but did not include insufficient_scope error in WWW-Authenticate',
        status: 'WARNING',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE]
      });
    } else {
      // No 403 observed - server might not require elevated scope
      checks.push({
        id: 'step-up-403-response',
        name: 'Server Returns 403 for Insufficient Scope',
        description:
          'No 403 insufficient_scope response observed - server may not require elevated scopes for privileged operations',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE]
      });
    }

    // Check 4: Multiple auth attempts (indicates step-up happened)
    if (authAttempts > 1) {
      checks.push({
        id: 'step-up-re-auth',
        name: 'Client Re-authenticated for Elevated Scope',
        description: `Client performed ${authAttempts} authentication attempts for scope escalation`,
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN],
        details: {
          authAttempts
        }
      });
    }

    // Check 5: Successful request after step-up
    const successAfter403 = requests.some(
      (r, i) =>
        r.responseStatus === 200 &&
        r.requestType === 'mcp-request' &&
        requests.slice(0, i).some((prev) => prev.responseStatus === 403)
    );

    if (successAfter403) {
      checks.push({
        id: 'step-up-success-after-escalation',
        name: 'Request Succeeds After Scope Escalation',
        description:
          'MCP request succeeded after re-authenticating with elevated scope',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN]
      });
    }
  }
}
