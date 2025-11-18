#!/usr/bin/env node

/**
 * SSE Retry Test Client
 *
 * Tests that the MCP client respects the SSE retry field when reconnecting.
 * This client connects to a test server that sends retry: field and closes
 * the connection, then validates that the client waits the appropriate time.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

    // Track reconnection events
    transport.onerror = (error) => {
      console.log(`Transport error: ${error.message}`);
    };

    transport.onclose = () => {
      console.log('Transport closed');
    };

    console.log('Initiating connection...');
    await client.connect(transport);
    console.log('Connected to MCP server');

    // Keep connection alive to observe reconnection behavior
    // The server will close the POST SSE stream and the client should reconnect via GET
    console.log('Waiting for reconnection cycle...');
    console.log(
      'Server will send priming event with retry field, then close POST SSE stream'
    );
    console.log(
      'Client should wait for retry period (2000ms) then reconnect via GET with Last-Event-ID'
    );

    // Wait long enough for:
    // 1. Server to send priming event with retry field on POST SSE stream (100ms)
    // 2. Server closes POST stream to trigger reconnection
    // 3. Client waits for retry period (2000ms expected)
    // 4. Client reconnects via GET with Last-Event-ID header
    await new Promise((resolve) => setTimeout(resolve, 6000));

    console.log('Test duration complete');

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
