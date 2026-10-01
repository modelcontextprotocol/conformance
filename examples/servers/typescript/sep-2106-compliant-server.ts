#!/usr/bin/env node

/**
 * SEP-2106 Compliant Reference Server (structuredContent wire-shape)
 *
 * A bare-bones Streamable-HTTP MCP server, implemented in raw Express, that
 * speaks the SEP-2106 wire format for the parts SEP-1613 + #295 don't reach:
 *
 *   - `tools/list` advertises a tool with `outputSchema.type === "array"`
 *     at the root, and another with `outputSchema.type === "number"` at the
 *     root (i.e. neither wrapped in `{type:"object"}`).
 *   - `tools/call` on those tools returns a JSON array (resp. raw number)
 *     directly in `structuredContent` — exactly the shape SEP-2106 permits
 *     and the MCP SDK Server (as of the version pinned in this repo) refuses
 *     to emit because `CallToolResultSchema.structuredContent` is still typed
 *     `Record<string, unknown>`.
 *
 * Why no SDK: until the SDK ships SEP-2106's widening of
 * `CallToolResultSchema.structuredContent` to `unknown`, the SDK Server
 * validates outgoing responses and rejects array/primitive structuredContent
 * with a JSON-RPC -32602. Writing JSON-RPC directly is the only way to
 * demonstrate a SEP-2106-compliant server today and gives a clean positive-
 * test target for the `sep-2106-structured-content` scenario.
 *
 * Used by `src/scenarios/server/negative.test.ts` as the positive case for
 * `Sep2106StructuredContentScenario`; all of its checks should succeed
 * against this server.
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

const PRIMITIVE_OUTPUT_SCHEMA = { type: 'number' };

const TOOLS = [
  {
    name: 'sep_2106_array_output_tool',
    description:
      'Returns an array of hourly forecasts directly in structuredContent (SEP-2106 wire shape)',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: ARRAY_OUTPUT_SCHEMA
  },
  {
    name: 'sep_2106_primitive_output_tool',
    description:
      'Returns a raw number directly in structuredContent (SEP-2106 wire shape)',
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
