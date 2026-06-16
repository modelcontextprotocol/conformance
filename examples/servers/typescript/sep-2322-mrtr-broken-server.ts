#!/usr/bin/env node

/**
 * SEP-2322 MRTR Broken Server — Negative Test Case
 *
 * Deliberately violates several SEP-2322 MUST requirements:
 * 1. Omits `resultType` field from InputRequiredResult responses
 * 2. Returns InputRequiredResult on `tools/list` (unsupported method)
 * 3. Accepts tampered requestState without integrity verification
 *
 * The conformance scenarios should emit FAILURE against this server.
 */

import express from 'express';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.PORT || '3011', 10);

// --- JSON-RPC dispatch ---

type Handler = (params: Record<string, unknown>) => unknown;

const handlers: Record<string, Handler> = {};

handlers['server/discover'] = () => ({
  supportedVersions: ['2026-07-28'],
  capabilities: {
    tools: {},
    prompts: {},
    elicitation: {}
  },
  serverInfo: { name: 'sep-2322-mrtr-broken-server', version: '1.0.0' }
});

// BUG 2: Returns InputRequiredResult on tools/list (unsupported method)
handlers['tools/list'] = () => ({
  resultType: 'input_required',
  inputRequests: {
    bogus: {
      method: 'elicitation/create',
      params: {
        message: 'This should not happen on tools/list',
        requestedSchema: { type: 'object', properties: {} }
      }
    }
  },
  tools: [
    {
      name: 'test_input_required_result_elicitation',
      description: 'Test tool for elicitation',
      inputSchema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'test_input_required_result_tampered_state',
      description: 'Test tool for tampered state',
      inputSchema: { type: 'object' as const, properties: {} }
    }
  ]
});

handlers['prompts/list'] = () => ({
  prompts: []
});

handlers['tools/call'] = (params) => {
  const toolName = params.name as string;
  const inputResponses = params.inputResponses as
    | Record<string, unknown>
    | undefined;

  switch (toolName) {
    case 'test_input_required_result_elicitation': {
      if (inputResponses?.['user_name']) {
        return {
          content: [{ type: 'text', text: 'Hello!' }]
        };
      }
      // BUG 1: Omits `resultType` field — spec says MUST include it
      return {
        // resultType: 'input_required',  <-- deliberately omitted
        inputRequests: {
          user_name: {
            method: 'elicitation/create',
            params: {
              message: 'What is your name?',
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            }
          }
        }
      };
    }

    case 'test_input_required_result_tampered_state': {
      if (inputResponses) {
        // BUG 3: Accepts ANY requestState without verification
        // A compliant server MUST reject tampered state
        return {
          content: [{ type: 'text', text: 'Accepted (no integrity check)' }]
        };
      }
      return {
        resultType: 'input_required',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: {
              message: 'Confirm?',
              requestedSchema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok']
              }
            }
          }
        },
        requestState: 'unprotected-state-' + randomUUID()
      };
    }

    default:
      throw { code: -32602, message: `Unknown tool: ${toolName}` };
  }
};

// --- Express app ---

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  const body = req.body as {
    jsonrpc: string;
    id: number;
    method: string;
    params?: Record<string, unknown>;
  };

  const handler = handlers[body.method];
  if (!handler) {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: `Method not found: ${body.method}` }
    });
    return;
  }

  try {
    const result = handler(body.params || {});
    res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: error.code || -32603,
        message: error.message || 'Internal error'
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `sep-2322-mrtr-broken-server running on http://localhost:${PORT}/mcp`
  );
});
