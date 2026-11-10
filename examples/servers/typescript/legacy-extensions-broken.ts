/** SDK server with deliberate serializer/accessor loss for negative controls. */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  SERVER_EXTENSIONS,
  EXTENSIONS_ECHO_TOOL
} from '../../../src/scenarios/legacy-extensions.js';

export async function startBrokenLegacyServer(
  mode:
    | 'advertisement'
    | 'reception'
    | 'settings'
    | 'missing-report'
    | 'wrong-version'
) {
  const sdk = new McpServer(
    { name: 'broken-extensions-server', version: '1.0.0' },
    { capabilities: { tools: {}, extensions: SERVER_EXTENSIONS } }
  );
  if (mode !== 'missing-report')
    sdk.registerTool(EXTENSIONS_ECHO_TOOL, { inputSchema: {} }, async () => {
      const extensions = structuredClone(
        sdk.server.getClientCapabilities()?.extensions ?? {}
      );
      if (mode === 'settings') extensions['com.example/conformance'] = {};
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              extensions: mode === 'reception' ? {} : extensions
            })
          }
        ]
      };
    });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true
  });
  // Reproduce serialization loss after the SDK has constructed the response.
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (
      mode === 'wrong-version' &&
      'result' in message &&
      'protocolVersion' in message.result
    ) {
      return send(
        {
          ...message,
          result: { ...message.result, protocolVersion: '2025-06-18' }
        },
        options
      );
    }
    if (
      mode === 'advertisement' &&
      'result' in message &&
      'capabilities' in message.result
    ) {
      const copy = structuredClone(message);
      delete (copy.result.capabilities as Record<string, unknown>).extensions;
      return send(copy, options);
    }
    return send(message, options);
  };
  await sdk.connect(transport);
  const app = express();
  app.use(express.json());
  app.all('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve);
    http.once('error', reject);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await sdk.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
