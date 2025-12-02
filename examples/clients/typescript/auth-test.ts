#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider
} from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { withOAuthRetry, handle401 } from './helpers/withOAuthRetry';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Fixed client metadata URL for CIMD conformance tests.
 * When server supports client_id_metadata_document_supported, this URL
 * will be used as the client_id instead of doing dynamic registration.
 */
const CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

/**
 * Context passed from the conformance test framework via MCP_CONFORMANCE_CONTEXT env var.
 *
 * WARNING: This schema is unstable and subject to change.
 * Currently only used for client credentials scenarios.
 * See: https://github.com/modelcontextprotocol/conformance/issues/51
 */
interface ConformanceContext {
  scenario: string;
  client_id?: string;
  // For JWT auth (private_key_jwt)
  private_key_pem?: string;
  signing_algorithm?: string;
  // For basic auth (client_secret_basic)
  client_secret?: string;
}

function getContext(
  passedContext?: Record<string, unknown>
): ConformanceContext {
  if (passedContext) {
    return passedContext as ConformanceContext;
  }
  const contextJson = process.env.MCP_CONFORMANCE_CONTEXT;
  if (!contextJson) {
    throw new Error('MCP_CONFORMANCE_CONTEXT environment variable is required');
  }
  return JSON.parse(contextJson);
}

/**
 * Create an OAuth provider based on the scenario type.
 */
function createProviderForScenario(
  context: ConformanceContext
): OAuthClientProvider | undefined {
  const { scenario } = context;

  // Client credentials scenarios use the dedicated provider classes
  if (scenario === 'auth/client-credentials-jwt') {
    if (
      !context.client_id ||
      !context.private_key_pem ||
      !context.signing_algorithm
    ) {
      throw new Error(
        'auth/client-credentials-jwt requires client_id, private_key_pem, and signing_algorithm in context'
      );
    }
    return new PrivateKeyJwtProvider({
      clientId: context.client_id,
      privateKey: context.private_key_pem,
      algorithm: context.signing_algorithm,
      clientName: 'conformance-client-credentials'
    });
  }

  if (scenario === 'auth/client-credentials-basic') {
    if (!context.client_id || !context.client_secret) {
      throw new Error(
        'auth/client-credentials-basic requires client_id and client_secret in context'
      );
    }
    return new ClientCredentialsProvider({
      clientId: context.client_id,
      clientSecret: context.client_secret,
      clientName: 'conformance-client-credentials'
    });
  }

  // For authorization code flow scenarios, return undefined to use withOAuthRetry
  return undefined;
}

/**
 * Auth client that handles both authorization code flow and client credentials flow
 * based on the scenario name in the conformance context.
 */
export async function runClient(
  serverUrl: string,
  passedContext?: Record<string, unknown>
): Promise<void> {
  const context = getContext(passedContext);
  logger.debug('Parsed context:', JSON.stringify(context, null, 2));

  const client = new Client(
    { name: 'test-auth-client', version: '1.0.0' },
    { capabilities: {} }
  );

  // Check if this is a client credentials scenario
  const clientCredentialsProvider = createProviderForScenario(context);

  let transport: StreamableHTTPClientTransport;

  if (clientCredentialsProvider) {
    // Client credentials flow - use the provider directly
    transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: clientCredentialsProvider
    });
  } else {
    // Authorization code flow - use withOAuthRetry middleware
    const oauthFetch = withOAuthRetry(
      'test-auth-client',
      new URL(serverUrl),
      handle401,
      CIMD_CLIENT_METADATA_URL
    )(fetch);

    transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: oauthFetch
    });
  }

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test <server-url>');
