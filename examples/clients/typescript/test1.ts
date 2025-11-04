#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main(): Promise<void> {
  const serverUrl = process.argv[2];

  if (!serverUrl) {
    console.error('Usage: test-client <server-url>');
    process.exit(1);
  }

  console.log(`Connecting to MCP server at: ${serverUrl}`);

  try {
    const client = new Client(
      {
        name: 'test-client',
        version: '1.0.0'
      },
      {
        capabilities: {}
      }
    );

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    console.log('✅ Successfully connected to MCP server');

    await client.listTools();
    console.log('✅ Successfully listed tools');

    await transport.close();
    console.log('✅ Connection closed successfully');

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to connect to MCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
