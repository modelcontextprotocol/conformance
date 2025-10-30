#!/usr/bin/env node

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main(): Promise<void> {
    const serverUrl = process.argv[2];

    if (!serverUrl) {
        console.error('Usage: test-broken-client <server-url>');
        process.exit(1);
    }

    console.log(`Connecting to MCP server at: ${serverUrl}`);

    try {
        const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

        await transport.start();

        const initRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                clientInfo: {
                    version: '1.0.0'
                },
                capabilities: {}
            }
        };

        const response = await fetch(serverUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(initRequest)
        });

        const result = await response.json();
        console.log('✅ Received response:', JSON.stringify(result, null, 2));

        await transport.close();
        console.log('✅ Connection closed');

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
