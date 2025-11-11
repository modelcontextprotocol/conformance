#!/usr/bin/env node

/**
 * Test client for SEP-1034 client-side elicitation defaults
 * This client intentionally returns empty/partial content in elicitation responses
 * to verify that the SDK applies defaults for omitted fields.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function main(): Promise<void> {
  const serverUrl = process.argv[2];

  if (!serverUrl) {
    console.error('Usage: elicitation-defaults-test <server-url>');
    process.exit(1);
  }

  console.log(`Connecting to MCP server at: ${serverUrl}`);

  try {
    const client = new Client(
      {
        name: 'elicitation-defaults-test-client',
        version: '1.0.0'
      },
      {
        capabilities: {
          elicitation: {}
        }
      }
    );

    // Register elicitation handler that returns empty content
    // The SDK should fill in defaults for all omitted fields
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      console.log(
        '📋 Received elicitation request:',
        JSON.stringify(request.params, null, 2)
      );
      console.log(
        '✅ Accepting with empty content - SDK should apply defaults'
      );

      // Return empty content - SDK should merge in defaults
      return {
        action: 'accept' as const,
        content: {}
      };
    });

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    await client.connect(transport);
    console.log('✅ Successfully connected to MCP server');

    // List available tools
    const tools = await client.listTools();
    console.log(
      '📦 Available tools:',
      tools.tools.map((t) => t.name)
    );

    // Call the test tool which will trigger elicitation
    const testTool = tools.tools.find(
      (t) => t.name === 'test_client_elicitation_defaults'
    );
    if (!testTool) {
      console.error('❌ Test tool not found: test_client_elicitation_defaults');
      process.exit(1);
    }

    console.log('🔧 Calling test_client_elicitation_defaults tool...');
    const result = await client.callTool({
      name: 'test_client_elicitation_defaults',
      arguments: {}
    });

    console.log('📄 Tool result:', JSON.stringify(result, null, 2));

    await transport.close();
    console.log('✅ Connection closed successfully');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
