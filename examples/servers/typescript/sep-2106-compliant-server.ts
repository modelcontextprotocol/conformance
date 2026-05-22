#!/usr/bin/env node

/**
 * SEP-2106 Compliant Reference Server
 *
 * A bare-bones Streamable-HTTP MCP server implemented in raw Express that
 * speaks the SEP-2106 wire format end-to-end:
 *   - `tools/list` advertises array and primitive `outputSchema` at the root
 *   - `tools/list` advertises `inputSchema.oneOf` composition
 *   - `tools/call` returns array and primitive `structuredContent` directly
 *   - Non-object `structuredContent` is accompanied by a TextContent block
 *     containing the serialized JSON (the existing SHOULD that becomes
 *     load-bearing under SEP-2106)
 *
 * We bypass the MCP SDK because, as of the SDK version pinned in this repo,
 * `CallToolResultSchema.structuredContent` is typed `Record<string, unknown>`
 * and the SDK Server validates outgoing responses against that schema. The
 * SDK therefore refuses to send a tools/call result with array or primitive
 * structuredContent, returning JSON-RPC -32602 instead — which is exactly
 * what SEP-2106 sets out to fix. Until the SDK ships SEP-2106 support, the
 * only way to demonstrate a fully-compliant server is to skip the SDK and
 * write JSON-RPC directly.
 *
 * Used by `src/scenarios/server/negative.test.ts` as the positive case for
 * `Sep2106Scenario`. All nine SEP-2106 checks should succeed against this
 * server.
 */

import express from 'express';

const PROTOCOL_VERSION = 'DRAFT-2026-v1';

const FORECAST_PAYLOAD = [
  { hour: '09:00', temp: 68, conditions: 'sunny' },
  { hour: '10:00', temp: 72, conditions: 'partly cloudy' },
  { hour: '11:00', temp: 75, conditions: 'cloudy' }
];

const COUNT_PAYLOAD = 42;

const ARRAY_OUTPUT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      hour: { type: 'string' },
      temp: { type: 'number' },
      conditions: { type: 'string' }
    },
    required: ['hour', 'temp', 'conditions']
  }
};

const ONEOF_INPUT_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id']
    },
    {
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name']
    }
  ]
};

const PRIMITIVE_OUTPUT_SCHEMA = { type: 'number' };

const TOOLS = [
  {
    name: 'sep_2106_array_output_tool',
    description: 'Returns an array of hourly forecasts in structuredContent',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: ARRAY_OUTPUT_SCHEMA
  },
  {
    name: 'sep_2106_oneof_input_tool',
    description: 'Accepts {id} OR {name} via inputSchema.oneOf',
    inputSchema: ONEOF_INPUT_SCHEMA
  },
  {
    name: 'sep_2106_primitive_output_tool',
    description: 'Returns a raw number in structuredContent',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: PRIMITIVE_OUTPUT_SCHEMA
  }
];

function handleRequest(body: any): { status: number; payload: unknown } {
  const { method, id, params } = body ?? {};

  if (method === 'initialize') {
    return {
      status: 200,
      payload: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'sep-2106-compliant', version: '1.0.0' },
          capabilities: { tools: {} }
        }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return { status: 202, payload: null };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      payload: { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'sep_2106_array_output_tool') {
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(FORECAST_PAYLOAD) }],
            structuredContent: FORECAST_PAYLOAD
          }
        }
      };
    }
    if (name === 'sep_2106_primitive_output_tool') {
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(COUNT_PAYLOAD) }],
            structuredContent: COUNT_PAYLOAD
          }
        }
      };
    }
    if (name === 'sep_2106_oneof_input_tool') {
      const branch = params?.arguments?.id
        ? 'id'
        : params?.arguments?.name
          ? 'name'
          : 'none';
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `branch=${branch}` }]
          }
        }
      };
    }
    return {
      status: 200,
      payload: {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` }
      }
    };
  }

  return {
    status: 200,
    payload: {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    }
  };
}

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  const { status, payload } = handleRequest(req.body);
  if (payload === null) {
    res.status(status).end();
    return;
  }
  res.status(status).json(payload);
});

const PORT = parseInt(process.env.PORT || '3009', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `SEP-2106 compliant test server running on http://localhost:${PORT}/mcp`
  );
});
