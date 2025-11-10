#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle401, withOAuthRetry } from './helpers/withOAuthRetry.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider.js';
import { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  auth,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';

export const handle401Broken = async (
  response: Response,
  provider: ConformanceOAuthProvider,
  next: FetchLike,
  serverUrl: string | URL
): Promise<void> => {
  // BROKEN: Use root-based PRM discovery exclusively, regardless of input.
  const resourceMetadataUrl = new URL(
    '/.well-known/oauth-protected-resource',
    typeof serverUrl === 'string' ? serverUrl : serverUrl.origin
  );

  let result = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    fetchFn: next
  });

  if (result === 'REDIRECT') {
    // Ordinarily, we'd wait for the callback to be handled here,
    // but in our conformance provider, we get the authorization code
    // during the redirect handling, so we can go straight to
    // retrying the auth step.
    // await provider.waitForCallback();

    const authorizationCode = await provider.getAuthCode();

    // TODO: this retry logic should be incorporated into the typescript SDK
    result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
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
    console.error('Usage: auth-test <server-url>');
    process.exit(1);
  }

  console.log(`Connecting to MCP server at: ${serverUrl}`);

  const client = new Client(
    {
      name: 'test-auth-client',
      version: '1.0.0'
    },
    {
      capabilities: {}
    }
  );

  // Create a custom fetch that uses the OAuth middleware with retry logic
  const oauthFetch = withOAuthRetry(
    'test-auth-client',
    new URL(serverUrl),
    handle401Broken
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  // Connect to the server - OAuth is handled automatically by the middleware
  await client.connect(transport);
  console.log('✅ Successfully connected to MCP server');

  await client.listTools();
  console.log('✅ Successfully listed tools');

  await transport.close();
  console.log('✅ Connection closed successfully');

  process.exit(0);
}

main();
