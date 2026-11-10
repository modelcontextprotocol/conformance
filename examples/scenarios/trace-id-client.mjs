/**
 * A client that passes examples/scenarios/trace-id.mjs. The runner appends
 * the server URL to the command. It uses the SDK, so it speaks the lifecycle
 * of spec version 2025-11-25, which is the default.
 */
import { argv } from 'node:process';
import { URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'trace-id-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(argv[2])));
await client.listTools();
await client.callTool({
  name: 'echo',
  arguments: { text: 'hello' },
  _meta: { 'com.example/traceId': 'trace-0001' }
});
await client.close();
