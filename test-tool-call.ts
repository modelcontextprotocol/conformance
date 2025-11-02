import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function testToolCall() {
    const client = new Client(
        {
            name: 'debug-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

    try {
        console.log('Connecting...');
        await client.connect(transport);
        console.log('Connected successfully');

        console.log('\nCalling test_simple_text tool...');
        const result = await client.callTool({
            name: 'test_simple_text',
            arguments: {}
        });

        console.log('Result:', JSON.stringify(result, null, 2));

        await client.close();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

testToolCall();
