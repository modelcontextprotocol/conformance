#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry } from './helpers/withOAuthRetry.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';

/**
 * Broken 401 handler that ignores the scope parameter from WWW-Authenticate header.
 * This simulates a client that doesn't follow the scope guidance provided by the server.
 */
const handle401Broken = async (
  response: Response,
  provider: ConformanceOAuthProvider,
  next: FetchLike,
  serverUrl: string | URL
): Promise<void> => {
  // BUG: Only respond to 401, not 403
  if (response.status !== 401) {
    return;
  }

  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  let result = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    scope,
    fetchFn: next
  });

  if (result === 'REDIRECT') {
    const authorizationCode = await provider.getAuthCode();

    result = await auth(provider, {
      serverUrl,
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

async function main(): Promise<void> {
  const serverUrl = process.argv[2];

  if (!serverUrl) {
    console.error('Usage: auth-test-scope-broken <server-url>');
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

  // Connect to the server - OAuth is handled by the middleware (but scope is ignored)
  await client.connect(transport);
  console.log('✅ Successfully connected to MCP server');

  await client.listTools();
  console.log('✅ Successfully listed tools');

  // Call a tool to test step-up auth scenarios
  await client.callTool({
    name: 'test-tool',
    arguments: {}
  });
  console.log('✅ Successfully called tool');

  await transport.close();
  console.log('✅ Connection closed successfully');

  process.exit(0);
}

main();
