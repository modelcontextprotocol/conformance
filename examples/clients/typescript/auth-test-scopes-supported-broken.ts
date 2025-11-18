#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withOAuthRetry } from './helpers/withOAuthRetry.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';

/**
 * Broken 401 handler that only requests a subset of scopes from scopes_supported.
 * This simulates a client that doesn't request all available scopes.
 */
const handle401Broken = async (
  response: Response,
  provider: ConformanceOAuthProvider,
  next: FetchLike,
  serverUrl: string | URL
): Promise<void> => {
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);

  // BUG: Only request the first scope instead of all scopes from scopes_supported
  // The auth function will use scopes_supported from the PRM if scope is not in WWW-Authenticate,
  // but we artificially limit it by passing a single scope
  let result = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    scope: 'mcp:basic', // Only request the first scope, not all of them
    fetchFn: next
  });

  if (result === 'REDIRECT') {
    const authorizationCode = await provider.getAuthCode();

    result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      scope: 'mcp:basic', // Only request the first scope, not all of them
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

async function main(): Promise<void> {
  const serverUrl = process.argv[2];

  if (!serverUrl) {
    console.error('Usage: auth-test-scopes-supported-broken <server-url>');
    process.exit(1);
  }

  console.log(`Connecting to MCP server at: ${serverUrl}`);

  const client = new Client(
    {
      name: 'test-auth-client-broken',
      version: '1.0.0'
    },
    {
      capabilities: {}
    }
  );

  // Create a custom fetch that uses the OAuth middleware with our broken 401 handler
  const oauthFetch = withOAuthRetry(
    'test-auth-client-broken',
    new URL(serverUrl),
    handle401Broken
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  // Connect to the server - OAuth is handled by the middleware (but only some scopes requested)
  await client.connect(transport);
  console.log('✅ Successfully connected to MCP server');

  await client.listTools();
  console.log('✅ Successfully listed tools');

  await transport.close();
  console.log('✅ Connection closed successfully');

  process.exit(0);
}

main();
