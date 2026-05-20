#!/usr/bin/env node

/**
 * SEP-2106 Negative Test Server
 *
 * Advertises `json_schema_2020_12_tool` but strips its inputSchema down to a
 * bare `type: "object"` with simple properties — dropping the JSON Schema
 * 2020-12 vocabulary (no $schema, $defs, additionalProperties, composition
 * (allOf/anyOf), conditional (if/then/else), or $anchor keywords).
 *
 * The json-schema-2020-12 scenario should emit FAILURE for the SEP-2106
 * composition / conditional / $anchor preservation checks (as well as the
 * SEP-1613 $schema / $defs / additionalProperties checks) against this server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

function createServer() {
  const server = new Server(
    { name: 'sep-2106-stripped-schema', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'json_schema_2020_12_tool',
        description:
          'Tool whose JSON Schema 2020-12 keywords have been stripped',
        // Stripped: only type + plain properties survive.
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' }
              }
            }
          }
        }
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

const PORT = parseInt(process.env.PORT || '3006', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `SEP-2106 negative test server running on http://localhost:${PORT}/mcp`
  );
});
