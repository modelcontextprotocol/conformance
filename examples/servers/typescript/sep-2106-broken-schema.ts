#!/usr/bin/env node

/**
 * SEP-2106 Negative Test Server
 *
 * Advertises the three SEP-2106 test tools but deliberately violates the
 * loosened-schema expectations:
 *   - sep_2106_array_output_tool: outputSchema is wrapped in { type: object },
 *     and structuredContent is wrapped in { items: [...] } instead of being
 *     an array directly. No TextContent fallback is emitted.
 *   - sep_2106_oneof_input_tool: inputSchema has no oneOf — the SDK stripped
 *     the composition keyword.
 *   - sep_2106_primitive_output_tool: outputSchema is wrapped in { type:
 *     object, properties: { value: { type: number } } }, and structuredContent
 *     is { value: 42 } instead of 42.
 *
 * The Sep2106Scenario should emit FAILURE/WARNING for every check against
 * this server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

const FORECAST_PAYLOAD = [
  { hour: '09:00', temp: 68, conditions: 'sunny' },
  { hour: '10:00', temp: 72, conditions: 'partly cloudy' },
  { hour: '11:00', temp: 75, conditions: 'cloudy' }
];

function createServer() {
  const server = new Server(
    { name: 'sep-2106-broken-schema', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'sep_2106_array_output_tool',
        description: '(broken) outputSchema wraps the array in an object',
        inputSchema: { type: 'object', properties: {} },
        // Wrong: SEP-2106 allows array-at-root; this server wraps it.
        outputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { type: 'object' }
            }
          },
          required: ['items']
        }
      },
      {
        name: 'sep_2106_oneof_input_tool',
        description: '(broken) inputSchema.oneOf was stripped',
        // Wrong: oneOf is missing entirely.
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' }
          }
        }
      },
      {
        name: 'sep_2106_primitive_output_tool',
        description: '(broken) primitive output is wrapped in an object',
        inputSchema: { type: 'object', properties: {} },
        // Wrong: SEP-2106 allows primitive-at-root; this server wraps it.
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    if (name === 'sep_2106_array_output_tool') {
      // Wrong: array wrapped in object, no TextContent fallback.
      return {
        content: [],
        structuredContent: { items: FORECAST_PAYLOAD }
      };
    }
    if (name === 'sep_2106_primitive_output_tool') {
      // Wrong: number wrapped in object, no TextContent fallback.
      return {
        content: [],
        structuredContent: { value: 42 }
      };
    }
    if (name === 'sep_2106_oneof_input_tool') {
      return {
        content: [{ type: 'text', text: 'ok' }]
      };
    }
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true
    };
  });

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

const PORT = parseInt(process.env.PORT || '3008', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `SEP-2106 negative test server running on http://localhost:${PORT}/mcp`
  );
});
