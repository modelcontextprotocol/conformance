#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

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

  const authProvider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: 'test-auth-client',
      redirect_uris: ['http://localhost:3000/callback']
    }
  );

  let transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider
  });

  // Try to connect - handle OAuth if needed
  try {
    await client.connect(transport);
    console.log('✅ Successfully connected to MCP server');
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      console.log('🔐 OAuth required - handling authorization...');

      // The provider will automatically fetch the auth code
      const authCode = await authProvider.getAuthCode();

      // Complete the auth flow
      await transport.finishAuth(authCode);

      // Close the old transport
      await transport.close();

      // Create a new transport with the authenticated provider
      transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        authProvider: authProvider
      });

      // Connect with the new transport
      await client.connect(transport);
      console.log('✅ Successfully connected with authentication');
    } else {
      throw error;
    }
  }

  await client.listTools();
  console.log('✅ Successfully listed tools');

  await transport.close();
  console.log('✅ Connection closed successfully');

  process.exit(0);
}

main();
