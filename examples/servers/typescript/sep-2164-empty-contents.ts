#!/usr/bin/env node

/**
 * SEP-2164 Negative Test Server
 *
 * Returns an empty contents array for any resources/read request, violating
 * the SEP-2164 MUST NOT. The sep-2164-resource-not-found scenario should
 * emit FAILURE for sep-2164-no-empty-contents against this server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

function createServer() {
  const server = new Server(
    { name: 'sep-2164-empty-contents', version: '1.0.0' },
    { capabilities: { resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: []
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: []
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

const PORT = parseInt(process.env.PORT || '3005', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `SEP-2164 negative test server running on http://localhost:${PORT}/mcp`
  );
});
