#!/usr/bin/env node

/**
 * Everything client - a single conformance test client that handles all scenarios.
 *
 * Usage: everything-client <server-url>
 *
 * The scenario name is read from the MCP_CONFORMANCE_SCENARIO environment variable,
 * which is set by the conformance test runner.
 *
 * This client routes to the appropriate behavior based on the scenario name,
 * consolidating all the individual test clients into one.
 */

import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider
} from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ClientConformanceContextSchema } from '../../../src/schemas/context.js';
import {
  auth,
  extractWWWAuthenticateParams
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  withOAuthRetry,
  withOAuthRetryWithProvider,
  handle401
} from './helpers/withOAuthRetry.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider.js';
import { logger } from './helpers/logger.js';

/**
 * Fixed client metadata URL for CIMD conformance tests.
 * When server supports client_id_metadata_document_supported, this URL
 * will be used as the client_id instead of doing dynamic registration.
 */
const CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

// Scenario handler type
type ScenarioHandler = (serverUrl: string) => Promise<void>;

// Registry of scenario handlers
const scenarioHandlers: Record<string, ScenarioHandler> = {};

// Helper to register a scenario handler
function registerScenario(name: string, handler: ScenarioHandler): void {
  scenarioHandlers[name] = handler;
}

// Helper to register multiple scenarios with the same handler
function registerScenarios(names: string[], handler: ScenarioHandler): void {
  for (const name of names) {
    scenarioHandlers[name] = handler;
  }
}

/**
 * Get a scenario handler by name.
 * Returns undefined if no handler is registered for the scenario.
 */
export function getHandler(scenarioName: string): ScenarioHandler | undefined {
  return scenarioHandlers[scenarioName];
}

// ============================================================================
// Basic scenarios (initialize, tools-call)
// ============================================================================

async function runBasicClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenarios(['initialize', 'tools-call'], runBasicClient);

// ============================================================================
// request-metadata scenario (SEP-2575)
// ============================================================================

async function runRequestMetadataClient(serverUrl: string): Promise<void> {
  logger.debug('Starting request-metadata client flow...');

  const meta = {
    'io.modelcontextprotocol/clientInfo': {
      name: 'conformance-test-client',
      version: '1.0.0'
    },
    'io.modelcontextprotocol/clientCapabilities': {
      tools: {},
      roots: {},
      sampling: {},
      elicitation: {}
    }
  };

  let activeVersion = 'DRAFT-2026-v1';

  const sendRequestWithNegotiation = async (
    method: string,
    requestId: string | number,
    params: any
  ): Promise<any> => {
    const getPayload = (version: string) => ({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: {
        ...params,
        _meta: {
          ...params?._meta,
          'io.modelcontextprotocol/protocolVersion': version
        }
      }
    });

    const send = async (version: string) => {
      return fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': version
        },
        body: JSON.stringify(getPayload(version))
      });
    };

    let response = await send(activeVersion);
    if (response.status === 400) {
      const clone = response.clone();
      try {
        const errorResult = await clone.json();
        if (errorResult.error?.code === -32001) {
          logger.debug(
            'Received UnsupportedProtocolVersionError, starting negotiation...'
          );
          const serverSupported: string[] =
            errorResult.error.data?.supported || [];
          const clientSupported = ['DRAFT-2026-v1'];
          const mutuallySupported = clientSupported.filter((v) =>
            serverSupported.includes(v)
          );
          if (mutuallySupported.length > 0) {
            activeVersion = mutuallySupported[0];
            logger.debug(
              `Mutually supported version found: ${activeVersion}. Retrying...`
            );
            response = await send(activeVersion);
          } else {
            logger.debug('No mutually supported version found. Aborting.');
          }
        }
      } catch (err) {
        logger.debug('Failed to parse error response as JSON:', err);
      }
    }

    if (!response.ok) {
      throw new Error(`${method} failed: ${response.status}`);
    }
    return response.json();
  };

  // Call server/discover (optional for clients, but every POST still needs
  // the header + _meta).
  logger.debug('Calling server/discover...');
  const discoverResult = await sendRequestWithNegotiation(
    'server/discover',
    'discover-1',
    { _meta: meta }
  );
  logger.debug(
    'Successfully discovered server capabilities:',
    JSON.stringify(discoverResult.result)
  );

  // Call tools/list with required inline _meta tags and header
  logger.debug('Calling tools/list with inline _meta...');
  const toolsResult = await sendRequestWithNegotiation('tools/list', 2, {
    _meta: meta
  });
  logger.debug(
    'Successfully listed tools statelessly:',
    JSON.stringify(toolsResult.result)
  );

  logger.debug('request-metadata client flow completed successfully');
}

// Register the scenario handler
registerScenario('request-metadata', runRequestMetadataClient);

// ============================================================================
// Auth scenarios - well-behaved client
// ============================================================================

async function runAuthClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetry(
    'test-auth-client',
    new URL(serverUrl),
    handle401,
    CIMD_CLIENT_METADATA_URL
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Connection closed successfully');
}

// Register all auth scenarios that use the well-behaved OAuth auth client
registerScenarios(
  [
    // Basic auth scenarios
    'auth/basic-cimd',
    'auth/basic-dcr',
    // Metadata discovery scenarios
    'auth/metadata-default',
    'auth/metadata-var1',
    'auth/metadata-var2',
    'auth/metadata-var3',
    // Backcompat scenarios
    'auth/2025-03-26-oauth-metadata-backcompat',
    'auth/2025-03-26-oauth-endpoint-fallback',
    // Scope handling scenarios
    'auth/scope-from-www-authenticate',
    'auth/scope-from-scopes-supported',
    'auth/scope-omitted-when-undefined',
    'auth/scope-step-up',
    'auth/scope-retry-limit',
    // Token endpoint auth method scenarios
    'auth/token-endpoint-auth-basic',
    'auth/token-endpoint-auth-post',
    'auth/token-endpoint-auth-none',
    // Resource mismatch (client should error when PRM resource doesn't match)
    'auth/resource-mismatch',
    // SEP-2207: Offline access / refresh token guidance (draft)
    'auth/offline-access-scope',
    'auth/offline-access-not-supported'
  ],
  runAuthClient
);

// SEP-2352: a well-behaved client keys credentials by issuer. Before each
// (re-)authorization, fetch PRM and rebind the provider; bindIssuer clears
// stale credentials when authorization_servers has changed so the SDK
// re-registers instead of presenting the previous AS's client_id.
async function runAuthMigrationClient(serverUrl: string): Promise<void> {
  const provider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: 'auth-migration-client',
      redirect_uris: ['http://localhost:3000/callback'],
      application_type: 'native'
    }
  );

  const issuerAware401: typeof handle401 = async (
    response,
    p,
    next,
    sUrl
  ): Promise<void> => {
    const { resourceMetadataUrl, scope } =
      extractWWWAuthenticateParams(response);
    if (resourceMetadataUrl) {
      const prm = await (await next(resourceMetadataUrl)).json();
      const issuer = Array.isArray(prm?.authorization_servers)
        ? prm.authorization_servers[0]
        : undefined;
      if (issuer) p.bindIssuer(issuer);
    }
    let result = await auth(p, {
      serverUrl: sUrl,
      resourceMetadataUrl,
      scope,
      fetchFn: next as FetchLike
    });
    if (result === 'REDIRECT') {
      const code = await p.getAuthCode();
      result = await auth(p, {
        serverUrl: sUrl,
        resourceMetadataUrl,
        scope,
        authorizationCode: code,
        fetchFn: next as FetchLike
      });
    }
  };

  const oauthFetch = withOAuthRetryWithProvider(
    provider,
    new URL(serverUrl),
    issuerAware401
  )(fetch);
  const client = new Client(
    { name: 'auth-migration-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });
  await client.connect(transport);
  await client.listTools(); // phase 1: AS₁
  await client.callTool({ name: 'test-tool', arguments: {} }); // phase 2: AS₂
  await transport.close();
}

registerScenario('auth/authorization-server-migration', runAuthMigrationClient);

// ============================================================================
// Elicitation defaults scenario
// ============================================================================

async function runElicitationDefaultsClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'elicitation-defaults-test-client', version: '1.0.0' },
    {
      capabilities: {
        elicitation: {
          applyDefaults: true
        }
      }
    }
  );

  // Register elicitation handler that returns empty content
  // The SDK should fill in defaults for all omitted fields
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    logger.debug(
      'Received elicitation request:',
      JSON.stringify(request.params, null, 2)
    );
    logger.debug('Accepting with empty content - SDK should apply defaults');

    // Return empty content - SDK should merge in defaults
    return {
      action: 'accept' as const,
      content: {}
    };
  });

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  // List available tools
  const tools = await client.listTools();
  logger.debug(
    'Available tools:',
    tools.tools.map((t) => t.name)
  );

  // Call the test tool which will trigger elicitation
  const testTool = tools.tools.find(
    (t) => t.name === 'test_client_elicitation_defaults'
  );
  if (!testTool) {
    throw new Error('Test tool not found: test_client_elicitation_defaults');
  }

  logger.debug('Calling test_client_elicitation_defaults tool...');
  const result = await client.callTool({
    name: 'test_client_elicitation_defaults',
    arguments: {}
  });

  logger.debug('Tool result:', JSON.stringify(result, null, 2));

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenario('elicitation-defaults', runElicitationDefaultsClient);

// ============================================================================
// Client Credentials scenarios
// ============================================================================

/**
 * Parse the conformance context from MCP_CONFORMANCE_CONTEXT env var.
 */
function parseContext() {
  const raw = process.env.MCP_CONFORMANCE_CONTEXT;
  if (!raw) {
    throw new Error('MCP_CONFORMANCE_CONTEXT not set');
  }
  return ClientConformanceContextSchema.parse(JSON.parse(raw));
}

/**
 * Client credentials with private_key_jwt authentication.
 */
export async function runClientCredentialsJwt(
  serverUrl: string
): Promise<void> {
  const ctx = parseContext();
  if (ctx.name !== 'auth/client-credentials-jwt') {
    throw new Error(`Expected jwt context, got ${ctx.name}`);
  }

  const provider = new PrivateKeyJwtProvider({
    clientId: ctx.client_id,
    privateKey: ctx.private_key_pem,
    algorithm: ctx.signing_algorithm || 'ES256'
  });

  const client = new Client(
    { name: 'conformance-client-credentials-jwt', version: '1.0.0' },
    { capabilities: {} }
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider
  });

  await client.connect(transport);
  logger.debug('Successfully connected with private_key_jwt auth');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenario('auth/client-credentials-jwt', runClientCredentialsJwt);

/**
 * Client credentials with client_secret_basic authentication.
 */
export async function runClientCredentialsBasic(
  serverUrl: string
): Promise<void> {
  const ctx = parseContext();
  if (ctx.name !== 'auth/client-credentials-basic') {
    throw new Error(`Expected basic context, got ${ctx.name}`);
  }

  const provider = new ClientCredentialsProvider({
    clientId: ctx.client_id,
    clientSecret: ctx.client_secret
  });

  const client = new Client(
    { name: 'conformance-client-credentials-basic', version: '1.0.0' },
    { capabilities: {} }
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider
  });

  await client.connect(transport);
  logger.debug('Successfully connected with client_secret_basic auth');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenario('auth/client-credentials-basic', runClientCredentialsBasic);

// ============================================================================
// Pre-registration scenario
// ============================================================================

/**
 * Pre-registration: client uses pre-registered credentials (no DCR).
 *
 * Server does not advertise registration_endpoint, so client must use
 * pre-configured client_id and client_secret passed via context.
 */
export async function runPreRegistration(serverUrl: string): Promise<void> {
  const ctx = parseContext();
  if (ctx.name !== 'auth/pre-registration') {
    throw new Error(`Expected pre-registration context, got ${ctx.name}`);
  }

  const client = new Client(
    { name: 'conformance-pre-registration', version: '1.0.0' },
    { capabilities: {} }
  );

  // Create provider with pre-registered credentials
  const provider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: 'conformance-pre-registration',
      redirect_uris: ['http://localhost:3000/callback']
    }
  );

  // Pre-set the client information so the SDK won't attempt DCR
  provider.saveClientInformation({
    client_id: ctx.client_id,
    client_secret: ctx.client_secret,
    redirect_uris: ['http://localhost:3000/callback']
  });

  // Use the provider-based middleware
  const oauthFetch = withOAuthRetryWithProvider(
    provider,
    new URL(serverUrl),
    handle401
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('Successfully connected with pre-registered credentials');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenario('auth/pre-registration', runPreRegistration);

// ============================================================================
// Cross-App Access (SEP-990) scenarios
// ============================================================================

/**
 * Enterprise-Managed Authorization (SEP-990)
 * Tests the complete flow: IDP ID token -> authorization grant -> access token -> MCP access.
 */
export async function runEnterpriseManagedAuthorization(
  serverUrl: string
): Promise<void> {
  const ctx = parseContext();
  if (ctx.name !== 'auth/enterprise-managed-authorization') {
    throw new Error(
      `Expected enterprise-managed-authorization context, got ${ctx.name}`
    );
  }

  logger.debug('Starting enterprise-managed authorization flow...');
  logger.debug('IDP Issuer:', ctx.idp_issuer);
  logger.debug('IDP Token Endpoint:', ctx.idp_token_endpoint);

  // Step 0: Discover resource and auth server from PRM metadata
  logger.debug('Step 0: Discovering resource and auth server via PRM...');
  const prmUrl = new URL(
    '/.well-known/oauth-protected-resource/mcp',
    serverUrl
  );
  const prmResponse = await fetch(prmUrl.toString());
  if (!prmResponse.ok) {
    throw new Error(`PRM discovery failed: ${prmResponse.status}`);
  }
  const prm = await prmResponse.json();
  const resource = prm.resource;
  const authServerUrl = prm.authorization_servers[0];
  logger.debug('Discovered resource:', resource);
  logger.debug('Discovered auth server:', authServerUrl);

  // Discover auth server metadata to find token endpoint
  const asMetadataUrl = new URL(
    '/.well-known/oauth-authorization-server',
    authServerUrl
  );
  const asMetadataResponse = await fetch(asMetadataUrl.toString());
  if (!asMetadataResponse.ok) {
    throw new Error(
      `Auth server metadata discovery failed: ${asMetadataResponse.status}`
    );
  }
  const asMetadata = await asMetadataResponse.json();
  const asTokenEndpoint = asMetadata.token_endpoint;
  const asIssuer = asMetadata.issuer;
  logger.debug('Auth server issuer:', asIssuer);
  logger.debug('Auth server token endpoint:', asTokenEndpoint);

  // Verify AS supports jwt-bearer grant type
  const grantTypes: string[] = asMetadata.grant_types_supported || [];
  if (!grantTypes.includes('urn:ietf:params:oauth:grant-type:jwt-bearer')) {
    throw new Error(
      `Auth server does not support jwt-bearer grant type. Supported: ${grantTypes.join(', ')}`
    );
  }
  logger.debug('Auth server supports jwt-bearer grant type');

  // Step 1: Token Exchange at IdP (IDP ID token -> ID-JAG)
  logger.debug('Step 1: Exchanging IDP ID token for ID-JAG at IdP...');
  const tokenExchangeParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    audience: asIssuer,
    resource: resource,
    subject_token: ctx.idp_id_token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    client_id: ctx.idp_client_id
  });

  const tokenExchangeResponse = await fetch(ctx.idp_token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenExchangeParams
  });

  if (!tokenExchangeResponse.ok) {
    const error = await tokenExchangeResponse.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenExchangeResult = await tokenExchangeResponse.json();
  const idJag = tokenExchangeResult.access_token; // ID-JAG (ID-bound JSON Assertion Grant)
  logger.debug('Token exchange successful, ID-JAG obtained');
  logger.debug('Issued token type:', tokenExchangeResult.issued_token_type);

  // Step 2: JWT Bearer Grant at AS (ID-JAG -> access token)
  // Client authenticates via client_secret_basic (RFC 7523 Section 5)
  logger.debug('Step 2: Exchanging ID-JAG for access token at Auth Server...');
  const jwtBearerParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: idJag
  });

  const basicAuth = Buffer.from(
    `${encodeURIComponent(ctx.client_id)}:${encodeURIComponent(ctx.client_secret)}`
  ).toString('base64');

  const tokenResponse = await fetch(asTokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`
    },
    body: jwtBearerParams
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`JWT bearer grant failed: ${error}`);
  }

  const tokenResult = await tokenResponse.json();
  logger.debug('JWT bearer grant successful, access token obtained');

  // Step 3: Use access token to access MCP server
  logger.debug('Step 3: Accessing MCP server with access token...');
  const client = new Client(
    { name: 'conformance-enterprise-managed-authorization', version: '1.0.0' },
    { capabilities: {} }
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`
      }
    }
  });

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Enterprise-managed authorization flow completed successfully');
}

registerScenario(
  'auth/enterprise-managed-authorization',
  runEnterpriseManagedAuthorization
);

// ============================================================================
// Main entry point
// ============================================================================

async function main(): Promise<void> {
  const scenarioName = process.env.MCP_CONFORMANCE_SCENARIO;
  const serverUrl = process.argv[2];

  if (!scenarioName || !serverUrl) {
    console.error(
      'Usage: MCP_CONFORMANCE_SCENARIO=<scenario> everything-client <server-url>'
    );
    console.error(
      '\nThe MCP_CONFORMANCE_SCENARIO env var is set automatically by the conformance runner.'
    );
    console.error('\nAvailable scenarios:');
    for (const name of Object.keys(scenarioHandlers).sort()) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }

  const handler = scenarioHandlers[scenarioName];
  if (!handler) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error('\nAvailable scenarios:');
    for (const name of Object.keys(scenarioHandlers).sort()) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }

  try {
    await handler(serverUrl);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Only run main when this file is executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
