/**
 * Server Auth Flow
 *
 * Runs the complete OAuth authentication flow against an MCP server and
 * generates conformance checks based on observed behavior. Supports all
 * client registration approaches (CIMD, DCR, pre-registration).
 *
 * This module uses the MCP SDK's real client with observation middleware
 * to verify server conformance.
 */

import type {
  ClientScenario,
  ClientScenarioOptions,
  ConformanceCheck,
  SpecVersion
} from '../../types';
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
 * Basic Auth Flow Scenario - Tests complete OAuth flow.
 */
export class BasicAuthFlowScenario implements ClientScenario {
  name = 'server-auth/basic-auth-flow';
  specVersions: SpecVersion[] = ['2025-11-25'];
  description = `Tests the complete OAuth authentication flow.

**Flow tested:**
1. Invalid token rejection -> 401
2. Unauthenticated MCP request -> 401 + WWW-Authenticate
3. PRM Discovery -> resource, authorization_servers
4. AS Metadata Discovery -> endpoints, PKCE support
5. Client Registration (CIMD or DCR, as supported)
6. Token Acquisition -> access_token
7. Authenticated MCP Call -> success

**Spec References:**
- RFC 9728 (Protected Resource Metadata)
- RFC 8414 (Authorization Server Metadata)
- RFC 7591 (Dynamic Client Registration)
- RFC 6750 (Bearer Token Usage)
- MCP Authorization Specification`;

  async run(
    serverUrl: string,
    options?: ClientScenarioOptions
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const observedRequests: ObservedRequest[] = [];
    const timestamp = () => new Date().toISOString();
    const interactive = options?.interactive ?? false;

    // Verify server rejects invalid tokens with 401
    // Per MCP spec: "Invalid or expired tokens MUST receive a HTTP 401 response"
    try {
      const invalidTokenResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer invalid'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'conformance-test', version: '1.0.0' }
          }
        })
      });

      checks.push({
        id: 'auth-invalid-token-rejected',
        name: 'Invalid Token Rejected',
        description:
          'Server returns 401 for requests with invalid Bearer token',
        status: invalidTokenResponse.status === 401 ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          invalidTokenResponse.status !== 401
            ? `Expected 401 but received ${invalidTokenResponse.status}`
            : undefined,
        specReferences: [
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN,
          ServerAuthSpecReferences.RFC_6750_BEARER_TOKEN
        ],
        details: {
          status: invalidTokenResponse.status
        }
      });
    } catch (error) {
      checks.push({
        id: 'auth-invalid-token-rejected',
        name: 'Invalid Token Rejected',
        description:
          'Server returns 401 for requests with invalid Bearer token',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN]
      });
    }

    // Create observation middleware to record all requests
    const observationMiddleware = createObservationMiddleware((req) => {
      observedRequests.push(req);
    });

    // Create OAuth provider for conformance testing with minimal client metadata for the broadest compatibility
    const provider = new ConformanceOAuthProvider(
      {
        client_name: 'MCP Conformance Test Client'
      },
      { interactive }
    );

    // Pre-populate client credentials for pre-registration flow
    if (options?.clientId) {
      provider.saveClientInformation({
        client_id: options.clientId,
        redirect_uris: [provider.redirectUrl as string],
        ...(options.clientSecret && {
          client_secret: options.clientSecret
        })
      });
    }

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
      this.analyzeRequests(observedRequests, checks, timestamp, serverUrl);
    } catch (error) {
      // Still analyze what we observed before the error
      this.analyzeRequests(observedRequests, checks, timestamp, serverUrl);

      checks.push({
        id: 'auth-flow-completion',
        name: 'OAuth Flow Completion',
        description: 'Complete OAuth authentication flow succeeded',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN]
      });
    }

    // If DCR is supported but wasn't exercised in the flow (e.g. CIMD was preferred),
    // do a standalone DCR registration test
    await this.testStandaloneDcr(observedRequests, checks, timestamp);

    // If CIMD is supported but wasn't exercised in the flow (e.g. pre-registered creds
    // were used or DCR was preferred), do a standalone CIMD auth flow test
    await this.testStandaloneCimd(
      observedRequests,
      checks,
      timestamp,
      serverUrl,
      options?.interactive ?? false
    );

    return checks;
  }

  /**
   * If DCR is supported but wasn't exercised in the flow, do a standalone
   * DCR registration to verify the server accepts it.
   */
  private async testStandaloneDcr(
    observedRequests: ObservedRequest[],
    checks: ConformanceCheck[],
    timestamp: () => string
  ): Promise<void> {
    const asMetadataRequest = observedRequests.find(
      (r) => r.requestType === 'as-metadata'
    );
    const asMetadata =
      asMetadataRequest?.responseStatus === 200 &&
      typeof asMetadataRequest.responseBody === 'object'
        ? (asMetadataRequest.responseBody as Record<string, unknown>)
        : null;

    // Skip if DCR is not supported or already tested
    // Client prefers CIMD over DCR, so skip if there's already a DCR request from the original flow
    const dcrSupported = !!asMetadata?.registration_endpoint;
    const dcrAlreadyTested = observedRequests.some(
      (r) => r.requestType === 'dcr-registration'
    );

    if (!dcrSupported || dcrAlreadyTested) {
      return;
    }

    const registrationEndpoint = asMetadata!.registration_endpoint as string;

    try {
      const response = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'MCP Conformance DCR Test',
          redirect_uris: ['http://localhost:3333/callback']
        })
      });

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        // Not valid JSON
      }

      performDcrChecks(checks, timestamp, {
        url: registrationEndpoint,
        status: response.status,
        body: responseBody
      });
    } catch (error) {
      checks.push({
        id: 'auth-dcr-registration',
        name: 'Dynamic Client Registration',
        description: 'Server accepted Dynamic Client Registration',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.RFC_7591_DCR_ENDPOINT]
      });
    }
  }

  /**
   * If CIMD is supported but wasn't exercised in the flow, do a standalone
   * CIMD auth flow to verify the AS accepts a URL-based client_id.
   */
  private async testStandaloneCimd(
    observedRequests: ObservedRequest[],
    checks: ConformanceCheck[],
    timestamp: () => string,
    serverUrl: string,
    interactive: boolean
  ): Promise<void> {
    const asMetadataRequest = observedRequests.find(
      (r) => r.requestType === 'as-metadata'
    );
    const asMetadata =
      asMetadataRequest?.responseStatus === 200 &&
      typeof asMetadataRequest.responseBody === 'object'
        ? (asMetadataRequest.responseBody as Record<string, unknown>)
        : null;

    const cimdSupported =
      asMetadata?.client_id_metadata_document_supported === true;

    // Check if the main flow already used CIMD (URL-based client_id in auth request)
    const authorizationRequest = observedRequests.find(
      (r) => r.requestType === 'authorization'
    );
    const cimdAlreadyTested =
      authorizationRequest &&
      typeof authorizationRequest.url === 'string' &&
      /client_id=https?%3A/.test(authorizationRequest.url);

    if (!cimdSupported || cimdAlreadyTested) {
      return;
    }

    // Reuse WWW-Authenticate params from the main flow's observed 401
    const unauthorizedRequest = observedRequests.find(
      (r) => r.responseStatus === 401 && r.requestType === 'mcp-request'
    );
    const resourceMetadataUrlStr =
      unauthorizedRequest?.wwwAuthenticate?.params.resource_metadata;
    const resourceMetadataUrl = resourceMetadataUrlStr
      ? new URL(resourceMetadataUrlStr)
      : undefined;
    const scope = unauthorizedRequest?.wwwAuthenticate?.params.scope;

    try {
      const cimdProvider = new ConformanceOAuthProvider(
        { client_name: 'MCP Conformance CIMD Test' },
        { interactive }
      );

      // Run auth flow with CIMD provider
      let result = await auth(cimdProvider, {
        serverUrl,
        resourceMetadataUrl,
        scope,
        fetchFn: fetch
      });

      if (result === 'REDIRECT') {
        const authorizationCode = await cimdProvider.getAuthCode();
        result = await auth(cimdProvider, {
          serverUrl,
          resourceMetadataUrl,
          scope,
          authorizationCode,
          fetchFn: fetch
        });
      }

      const tokens = await cimdProvider.tokens();

      checks.push({
        id: 'auth-cimd-flow',
        name: 'CIMD Authentication Flow',
        description:
          'AS accepts URL-based client_id via CIMD authentication flow',
        status: tokens?.access_token ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        errorMessage: !tokens?.access_token
          ? `Auth flow completed with result "${result}" but no access token obtained`
          : undefined,
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_DCR],
        details: {
          hasAccessToken: !!tokens?.access_token,
          tokenType: tokens?.token_type
        }
      });
    } catch (error) {
      checks.push({
        id: 'auth-cimd-flow',
        name: 'CIMD Authentication Flow',
        description:
          'AS accepts URL-based client_id via CIMD authentication flow',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: error instanceof Error ? error.message : String(error),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_DCR]
      });
    }
  }

  /**
   * Analyze observed requests and generate conformance checks.
   */
  private analyzeRequests(
    requests: ObservedRequest[],
    checks: ConformanceCheck[],
    timestamp: () => string,
    serverUrl: string
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

        const isBearer = wwwAuth.scheme.toLowerCase() === 'bearer';
        checks.push({
          id: 'auth-www-authenticate-header',
          name: 'WWW-Authenticate Header Present',
          description:
            'Server includes WWW-Authenticate header with Bearer scheme in 401 response',
          status: isBearer ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          errorMessage: !isBearer
            ? `Expected Bearer scheme but received "${wwwAuth.scheme}"`
            : undefined,
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

        // Check for scope parameter (MCP spec: servers SHOULD include scope)
        checks.push({
          id: 'auth-www-authenticate-scope',
          name: 'Scope in WWW-Authenticate',
          description:
            'Server includes scope parameter in WWW-Authenticate header',
          status: wwwAuth.params.scope ? 'SUCCESS' : 'WARNING',
          timestamp: timestamp(),
          specReferences: [ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE],
          details: wwwAuth.params.scope
            ? { scope: wwwAuth.params.scope }
            : undefined
        });
      } else {
        checks.push({
          id: 'auth-www-authenticate-header',
          name: 'WWW-Authenticate Header Present',
          description:
            'Server includes WWW-Authenticate header with Bearer scheme in 401 response',
          status: 'FAILURE',
          timestamp: timestamp(),
          errorMessage:
            'WWW-Authenticate header missing from 401 response (required by RFC 7235 Section 3.1)',
          specReferences: [
            ServerAuthSpecReferences.RFC_6750_WWW_AUTHENTICATE,
            ServerAuthSpecReferences.RFC_7235_WWW_AUTHENTICATE
          ]
        });
      }
    } else {
      checks.push({
        id: 'auth-401-response',
        name: 'Unauthenticated Request Returns 401',
        description:
          'Server returns 401 Unauthorized for unauthenticated MCP requests',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'No 401 response observed',
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

        // Check PRM resource field (RFC 9728 Section 3.2)
        if (prm.resource) {
          const resource = prm.resource as string;
          const resourceMatches =
            resource === serverUrl || serverUrl.startsWith(resource);

          checks.push({
            id: 'auth-prm-resource',
            name: 'PRM Resource Field',
            description:
              'Protected Resource Metadata includes resource field matching server URL',
            status: resourceMatches ? 'SUCCESS' : 'FAILURE',
            timestamp: timestamp(),
            errorMessage: !resourceMatches
              ? `PRM resource "${resource}" does not match server URL "${serverUrl}"`
              : undefined,
            specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
            details: {
              resource,
              serverUrl
            }
          });
        } else {
          checks.push({
            id: 'auth-prm-resource',
            name: 'PRM Resource Field',
            description:
              'Protected Resource Metadata includes resource field matching server URL',
            status: 'FAILURE',
            timestamp: timestamp(),
            errorMessage: 'PRM response missing required resource field',
            specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE]
          });
        }

        const hasAuthServers =
          prm.authorization_servers && Array.isArray(prm.authorization_servers);
        checks.push({
          id: 'auth-prm-authorization-servers',
          name: 'PRM Contains Authorization Servers',
          description:
            'Protected Resource Metadata includes authorization_servers array',
          status: hasAuthServers ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          errorMessage: !hasAuthServers
            ? 'PRM response missing required authorization_servers array'
            : undefined,
          specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
          details: hasAuthServers
            ? { authorizationServers: prm.authorization_servers }
            : undefined
        });
      }
    } else {
      checks.push({
        id: 'auth-prm-discovery',
        name: 'Protected Resource Metadata Discovery',
        description: 'Client discovered Protected Resource Metadata endpoint',
        status: 'FAILURE',
        errorMessage: 'No PRM discovery request observed',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_PRM_DISCOVERY
        ]
      });
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

        // Required fields per RFC 8414 and MCP auth spec
        const hasIssuer = !!metadata.issuer;
        const hasAuthorizationEndpoint = !!metadata.authorization_endpoint;
        const hasTokenEndpoint = !!metadata.token_endpoint;
        const codeChallengeMethodsSupported =
          metadata.code_challenge_methods_supported;
        const supportsPkceS256 =
          Array.isArray(codeChallengeMethodsSupported) &&
          codeChallengeMethodsSupported.includes('S256');

        // Build list of missing/invalid fields
        const issues = [];
        if (!hasIssuer) issues.push('missing issuer');
        if (!hasAuthorizationEndpoint)
          issues.push('missing authorization_endpoint');
        if (!hasTokenEndpoint) issues.push('missing token_endpoint');
        if (!supportsPkceS256)
          issues.push('code_challenge_methods_supported must include S256');

        const allValid = issues.length === 0;

        checks.push({
          id: 'auth-as-metadata-fields',
          name: 'AS Metadata Required Fields',
          description:
            'Authorization Server metadata includes all required fields',
          status: allValid ? 'SUCCESS' : 'FAILURE',
          errorMessage: !allValid ? issues.join('; ') : undefined,
          timestamp: timestamp(),
          specReferences: [
            ServerAuthSpecReferences.RFC_8414_AS_FIELDS,
            ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA
          ],
          details: {
            issuer: metadata.issuer,
            authorizationEndpoint: metadata.authorization_endpoint,
            tokenEndpoint: metadata.token_endpoint,
            codeChallengeMethodsSupported,
            registrationEndpoint: metadata.registration_endpoint
          }
        });
      }
    } else {
      checks.push({
        id: 'auth-as-metadata-discovery',
        name: 'Authorization Server Metadata Discovery',
        description: 'Client discovered Authorization Server metadata',
        status: 'FAILURE',
        errorMessage: 'No AS metadata discovery request observed',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA
        ]
      });
    }

    // Phase 4: Client Registration
    // Determine AS capabilities from observed metadata
    const asMetadata =
      asMetadataRequest?.responseStatus === 200 &&
      typeof asMetadataRequest.responseBody === 'object'
        ? (asMetadataRequest.responseBody as Record<string, unknown>)
        : null;

    const cimdSupported =
      asMetadata?.client_id_metadata_document_supported === true;
    const dcrSupported = !!asMetadata?.registration_endpoint;

    const dcrRequest = requests.find(
      (r) => r.requestType === 'dcr-registration'
    );

    // Report AS registration capabilities
    checks.push({
      id: 'auth-as-cimd-supported',
      name: 'AS Supports CIMD',
      description:
        'Authorization server advertises client_id_metadata_document_supported',
      status: cimdSupported ? 'SUCCESS' : 'INFO',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.MCP_AUTH_DCR],
      details: { cimdSupported }
    });

    checks.push({
      id: 'auth-as-dcr-supported',
      name: 'AS Supports DCR',
      description: 'Authorization server advertises registration_endpoint',
      status: dcrSupported ? 'SUCCESS' : 'INFO',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.RFC_7591_DCR_ENDPOINT,
        ServerAuthSpecReferences.MCP_AUTH_DCR
      ],
      details: {
        registrationEndpoint: asMetadata?.registration_endpoint
      }
    });

    // Validate server accepted DCR registration if it occurred
    if (dcrRequest) {
      performDcrChecks(checks, timestamp, {
        url: dcrRequest.url,
        status: dcrRequest.responseStatus,
        body: dcrRequest.responseBody
      });
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
    } else {
      checks.push({
        id: 'auth-token-request',
        name: 'Token Acquisition',
        description: 'Client obtained access token from token endpoint',
        status: 'FAILURE',
        errorMessage: 'No token request observed',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_REQUEST,
          ServerAuthSpecReferences.MCP_AUTH_ACCESS_TOKEN
        ]
      });
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

function performDcrChecks(
  checks: ConformanceCheck[],
  timestamp: () => string,
  response: { url: string; status: number; body?: unknown }
): void {
  const success = response.status === 201;
  checks.push({
    id: 'auth-dcr-registration',
    name: 'Dynamic Client Registration',
    description: 'Server accepted Dynamic Client Registration',
    status: success ? 'SUCCESS' : 'FAILURE',
    timestamp: timestamp(),
    errorMessage: !success
      ? `Registration endpoint returned ${response.status}`
      : undefined,
    specReferences: [
      ServerAuthSpecReferences.RFC_7591_DCR_ENDPOINT,
      ServerAuthSpecReferences.MCP_AUTH_DCR
    ],
    details: {
      url: response.url,
      status: response.status
    }
  });

  if (success && typeof response.body === 'object' && response.body !== null) {
    const client = response.body as Record<string, unknown>;
    checks.push({
      id: 'auth-dcr-response',
      name: 'DCR Response Contains Client Credentials',
      description: 'DCR response includes client_id',
      status: client.client_id ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: !client.client_id
        ? 'DCR response missing client_id'
        : undefined,
      specReferences: [ServerAuthSpecReferences.RFC_7591_DCR_RESPONSE],
      details: {
        hasClientId: !!client.client_id,
        hasClientSecret: !!client.client_secret
      }
    });
  }
}
