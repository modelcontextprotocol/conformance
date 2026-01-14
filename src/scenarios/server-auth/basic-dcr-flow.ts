/**
 * Basic DCR Flow Scenario
 *
 * Tests the complete OAuth authentication flow using Dynamic Client Registration:
 * 1. Unauthenticated MCP request triggers 401 + WWW-Authenticate header
 * 2. Protected Resource Metadata (PRM) discovery
 * 3. Authorization Server (AS) metadata discovery
 * 4. Dynamic Client Registration (DCR)
 * 5. Token acquisition via authorization_code flow
 * 6. Authenticated MCP tool call with Bearer token
 *
 * This scenario uses the MCP SDK's real client with observation middleware
 * to verify server conformance.
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
 * Basic DCR Flow - Tests complete OAuth flow with Dynamic Client Registration.
 */
export class BasicDcrFlowScenario implements ClientScenario {
  name = 'server-auth/basic-dcr-flow';
  description = `Tests the complete OAuth authentication flow using Dynamic Client Registration.

**Flow tested:**
1. Unauthenticated MCP request -> 401 + WWW-Authenticate
2. PRM Discovery -> authorization_servers
3. AS Metadata Discovery -> registration_endpoint, token_endpoint
4. DCR Registration -> client_id, client_secret
5. Token Acquisition -> access_token
6. Authenticated MCP Call -> success

**Spec References:**
- RFC 9728 (Protected Resource Metadata)
- RFC 8414 (Authorization Server Metadata)
- RFC 7591 (Dynamic Client Registration)
- RFC 6750 (Bearer Token Usage)
- MCP Authorization Specification`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const observedRequests: ObservedRequest[] = [];
    const timestamp = () => new Date().toISOString();

    // Create observation middleware to record all requests
    const observationMiddleware = createObservationMiddleware((req) => {
      observedRequests.push(req);
    });

    // Create OAuth provider for conformance testing
    const provider = new ConformanceOAuthProvider(
      'http://localhost:3000/callback',
      {
        client_name: 'MCP Conformance Test Client',
        redirect_uris: ['http://localhost:3000/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post'
      }
    );

    // Handle 401 with OAuth flow
    const handle401 = async (
      response: Response,
      next: FetchLike,
      url: string
    ): Promise<void> => {
      const { resourceMetadataUrl, scope } =
        extractWWWAuthenticateParams(response);

      let result = await auth(provider, {
        serverUrl: url,
        resourceMetadataUrl,
        scope,
        fetchFn: next
      });

      if (result === 'REDIRECT') {
        // Get auth code from the redirect (auto-login)
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

        if (response.status === 401) {
          const url = typeof input === 'string' ? input : input.toString();
          await handle401(response.clone(), next, url);
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

    // Compose middlewares: observation wraps oauth handling
    const enhancedFetch = applyMiddlewares(
      observationMiddleware,
      oauthMiddleware
    )(fetch);

    try {
      // Create MCP client
      const client = new Client(
        { name: 'conformance-test-client', version: '1.0.0' },
        { capabilities: {} }
      );

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: enhancedFetch
      });

      // Connect triggers the OAuth flow
      await client.connect(transport);

      // Make an authenticated call
      try {
        await client.listTools();
      } catch {
        // Tool listing may fail if server doesn't have tools, but that's ok
      }

      await transport.close();

      // Analyze observed requests to generate conformance checks
      this.analyzeRequests(observedRequests, checks, timestamp);
    } catch (error) {
      // Still analyze what we observed before the error
      this.analyzeRequests(observedRequests, checks, timestamp);

      checks.push({
        id: 'auth-flow-completion',
        name: 'OAuth Flow Completion',
        description: 'Complete OAuth authentication flow',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN]
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
    timestamp: () => string
  ): void {
    // Phase 1: Check for 401 response with WWW-Authenticate
    const unauthorizedRequest = requests.find(
      (r) => r.responseStatus === 401 && r.requestType === 'mcp-request'
    );

    if (unauthorizedRequest) {
      checks.push({
        id: 'auth-401-response',
        name: 'Unauthenticated Request Returns 401',
        description:
          'Server returns 401 Unauthorized for unauthenticated MCP requests',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7235_401_RESPONSE,
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN
        ],
        details: {
          url: unauthorizedRequest.url,
          status: unauthorizedRequest.responseStatus
        }
      });

      // Check WWW-Authenticate header
      if (unauthorizedRequest.wwwAuthenticate) {
        const wwwAuth = unauthorizedRequest.wwwAuthenticate;

        checks.push({
          id: 'auth-www-authenticate-header',
          name: 'WWW-Authenticate Header Present',
          description:
            'Server includes WWW-Authenticate header in 401 response',
          status:
            wwwAuth.scheme.toLowerCase() === 'bearer' ? 'SUCCESS' : 'WARNING',
          timestamp: timestamp(),
          specReferences: [
            ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE,
            ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE
          ],
          details: {
            scheme: wwwAuth.scheme,
            params: wwwAuth.params
          }
        });

        // Check for resource_metadata parameter
        if (wwwAuth.params.resource_metadata) {
          checks.push({
            id: 'auth-resource-metadata-param',
            name: 'Resource Metadata URL in WWW-Authenticate',
            description:
              'WWW-Authenticate header includes resource_metadata parameter',
            status: 'INFO',
            timestamp: timestamp(),
            specReferences: [
              ServerAuthSpecReferences.RFC_9728_WWW_AUTHENTICATE
            ],
            details: {
              resourceMetadata: wwwAuth.params.resource_metadata
            }
          });
        }
      } else {
        checks.push({
          id: 'auth-www-authenticate-header',
          name: 'WWW-Authenticate Header Present',
          description:
            'Server should include WWW-Authenticate header in 401 response',
          status: 'INFO',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE]
        });
      }
    } else {
      checks.push({
        id: 'auth-401-response',
        name: 'Unauthenticated Request Returns 401',
        description:
          'No 401 response observed - server may not require authentication',
        status: 'FAILURE',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_7235_401_RESPONSE]
      });
    }

    // Phase 2: PRM Discovery
    const prmRequest = requests.find((r) => r.requestType === 'prm-discovery');
    if (prmRequest) {
      checks.push({
        id: 'auth-prm-discovery',
        name: 'Protected Resource Metadata Discovery',
        description: 'Client discovered Protected Resource Metadata endpoint',
        status: prmRequest.responseStatus === 200 ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_PRM_DISCOVERY
        ],
        details: {
          url: prmRequest.url,
          status: prmRequest.responseStatus,
          body: prmRequest.responseBody
        }
      });

      // Check PRM response content
      if (
        prmRequest.responseStatus === 200 &&
        typeof prmRequest.responseBody === 'object'
      ) {
        const prm = prmRequest.responseBody as Record<string, unknown>;

        if (
          prm.authorization_servers &&
          Array.isArray(prm.authorization_servers)
        ) {
          checks.push({
            id: 'auth-prm-authorization-servers',
            name: 'PRM Contains Authorization Servers',
            description:
              'Protected Resource Metadata includes authorization_servers array',
            status: 'SUCCESS',
            timestamp: timestamp(),
            specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
            details: {
              authorizationServers: prm.authorization_servers
            }
          });
        }
      }
    }

    // Phase 3: AS Metadata Discovery
    const asMetadataRequest = requests.find(
      (r) => r.requestType === 'as-metadata'
    );
    if (asMetadataRequest) {
      checks.push({
        id: 'auth-as-metadata-discovery',
        name: 'Authorization Server Metadata Discovery',
        description: 'Client discovered Authorization Server metadata',
        status:
          asMetadataRequest.responseStatus === 200 ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA
        ],
        details: {
          url: asMetadataRequest.url,
          status: asMetadataRequest.responseStatus
        }
      });

      // Check AS metadata required fields
      if (
        asMetadataRequest.responseStatus === 200 &&
        typeof asMetadataRequest.responseBody === 'object'
      ) {
        const metadata = asMetadataRequest.responseBody as Record<
          string,
          unknown
        >;
        const hasTokenEndpoint = !!metadata.token_endpoint;
        const hasRegistrationEndpoint = !!metadata.registration_endpoint;

        checks.push({
          id: 'auth-as-metadata-fields',
          name: 'AS Metadata Required Fields',
          description:
            'Authorization Server metadata includes required endpoints',
          status: hasTokenEndpoint ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
          details: {
            hasTokenEndpoint,
            hasRegistrationEndpoint,
            tokenEndpoint: metadata.token_endpoint,
            registrationEndpoint: metadata.registration_endpoint
          }
        });
      }
    }

    // Phase 4: DCR Registration
    const dcrRequest = requests.find(
      (r) => r.requestType === 'dcr-registration'
    );
    if (dcrRequest) {
      checks.push({
        id: 'auth-dcr-registration',
        name: 'Dynamic Client Registration',
        description: 'Client registered via Dynamic Client Registration',
        status: dcrRequest.responseStatus === 201 ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7591_DCR_ENDPOINT,
          ServerAuthSpecReferences.MCP_AUTH_DCR
        ],
        details: {
          url: dcrRequest.url,
          status: dcrRequest.responseStatus
        }
      });

      // Check DCR response
      if (
        dcrRequest.responseStatus === 201 &&
        typeof dcrRequest.responseBody === 'object'
      ) {
        const client = dcrRequest.responseBody as Record<string, unknown>;

        checks.push({
          id: 'auth-dcr-response',
          name: 'DCR Response Contains Client Credentials',
          description: 'DCR response includes client_id',
          status: client.client_id ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_7591_DCR_RESPONSE],
          details: {
            hasClientId: !!client.client_id,
            hasClientSecret: !!client.client_secret
          }
        });
      }
    }

    // Phase 5: Token Request
    const tokenRequest = requests.find(
      (r) => r.requestType === 'token-request'
    );
    if (tokenRequest) {
      checks.push({
        id: 'auth-token-request',
        name: 'Token Acquisition',
        description: 'Client obtained access token from token endpoint',
        status: tokenRequest.responseStatus === 200 ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_REQUEST,
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN
        ],
        details: {
          url: tokenRequest.url,
          status: tokenRequest.responseStatus
        }
      });

      // Check token response
      if (
        tokenRequest.responseStatus === 200 &&
        typeof tokenRequest.responseBody === 'object'
      ) {
        const tokens = tokenRequest.responseBody as Record<string, unknown>;

        checks.push({
          id: 'auth-token-response',
          name: 'Token Response Contains Access Token',
          description: 'Token response includes access_token',
          status: tokens.access_token ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.OAUTH_2_1_TOKEN_REQUEST],
          details: {
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            tokenType: tokens.token_type
          }
        });
      }
    }

    // Phase 6: Authenticated MCP Request
    const authenticatedRequest = requests.find(
      (r) =>
        r.requestType === 'mcp-request' &&
        r.requestHeaders['authorization']?.startsWith('Bearer ') &&
        r.responseStatus === 200
    );

    if (authenticatedRequest) {
      checks.push({
        id: 'auth-authenticated-request',
        name: 'Authenticated MCP Request Succeeds',
        description: 'MCP request with Bearer token succeeds',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_6750_BEARER_TOKEN,
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN
        ],
        details: {
          url: authenticatedRequest.url,
          status: authenticatedRequest.responseStatus
        }
      });

      // Overall flow success
      checks.push({
        id: 'auth-flow-completion',
        name: 'OAuth Flow Completion',
        description: 'Complete OAuth authentication flow succeeded',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN]
      });
    }
  }
}
