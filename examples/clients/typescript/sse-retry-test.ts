#!/usr/bin/env node

/**
 * SSE Retry Test Client
 *
 * Tests that the MCP client respects the SSE retry field when reconnecting.
 * This client connects to a test server that closes the SSE stream mid-tool-call,
 * then waits for the client to reconnect and sends the tool result.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

async function main(): Promise<void> {
  const serverUrl = process.argv[2];

  if (!serverUrl) {
    console.error('Usage: sse-retry-test <server-url>');
    process.exit(1);
  }

  console.log(`Connecting to MCP server at: ${serverUrl}`);
  console.log('This test validates SSE retry field compliance (SEP-1699)');

  try {
    const client = new Client(
      {
        name: 'sse-retry-test-client',
        version: '1.0.0'
      },
      {
        capabilities: {}
      }
    );

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      reconnectionOptions: {
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 10000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 3
      }
    });

    transport.onerror = (error) => {
      console.log(`Transport error: ${error.message}`);
    };

    transport.onclose = () => {
      console.log('Transport closed');
    };

    console.log('Initiating connection...');
    await client.connect(transport);
    console.log('Connected to MCP server');

    console.log('Calling test_reconnection tool...');
    console.log(
      'Server will close SSE stream mid-call and send result after reconnection'
    );

    const result = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'test_reconnection',
          arguments: {}
        }
      },
      CallToolResultSchema
    );

    console.log('Tool call completed:', JSON.stringify(result, null, 2));

    await transport.close();
    console.log('Connection closed successfully');

    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
