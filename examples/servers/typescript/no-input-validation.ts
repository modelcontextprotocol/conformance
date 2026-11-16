#!/usr/bin/env node

/**
 * Negative fixture for tools-call-input-validation (SEP-1303): publishes an
 * inputSchema for test_input_validation but, like any handler on the
 * low-level Server API, never checks tools/call arguments against it, so the
 * tool runs on schema-invalid input and the check can be shown to emit
 * FAILURE.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

function createServer() {
  const server = new Server(
    { name: 'no-input-validation', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'test_input_validation',
        description: 'Publishes a schema but does not enforce it',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'integer', minimum: 1, maximum: 10 }
          },
          required: ['value']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: 'text',
        text: `executed: ${JSON.stringify(request.params.arguments?.value)}`
      }
    ]
  }));

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
        },
        id: null
      });
    }
  }
});

const PORT = parseInt(process.env.PORT || '3010', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `No input validation negative test server running on http://localhost:${PORT}/mcp`
  );
});
