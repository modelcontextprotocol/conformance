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
    'auth/token-endpoint-auth-none'
  ],
  runAuthClient
);

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
    client_secret: ctx.client_secret
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

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Connection closed successfully');
}

registerScenario('auth/pre-registration', runPreRegistration);

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
