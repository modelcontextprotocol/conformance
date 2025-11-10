#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry } from './helpers/withOAuthRetry.js';

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
    new URL(serverUrl)
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
