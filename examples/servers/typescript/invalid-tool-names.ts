#!/usr/bin/env node

/**
 * Negative fixture for the tools-name-format check: advertises tool names that
 * violate the 2025-11-25 Tool Names rules (spec #tool-names) by bypassing the
 * SDK's registerTool validation, so the check can be shown to emit WARNING.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  type ListToolsResult
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import {
  inspectDraftRequest,
  sendDraftDiscovery,
  sendDraftMethodNotFound,
  sendDraftResult
} from './helpers/draft-protocol.js';

const TOOL_CATALOG: ListToolsResult['tools'] = [
  {
    name: 'bad tool name',
    description: 'Deliberately invalid tool name for conformance testing',
    inputSchema: { type: 'object' }
  },
  {
    name: 'valid_tool',
    description: 'A conformant tool name',
    inputSchema: { type: 'object' }
  }
];

function createServer() {
  const server = new Server(
    { name: 'invalid-tool-names', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_CATALOG
  }));

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  try {
    const draft = inspectDraftRequest(req, res);
    if (draft.kind === 'rejected') return;
    if (draft.kind === 'draft') {
      if (draft.method === 'server/discover') {
        return sendDraftDiscovery(
          res,
          draft.id,
          { name: 'invalid-tool-names', version: '1.0.0' },
          { tools: {} }
        );
      }
      if (draft.method === 'tools/list') {
        return sendDraftResult(res, draft.id, { tools: TOOL_CATALOG });
      }
      return sendDraftMethodNotFound(res, draft.id);
    }
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

const PORT = parseInt(process.env.PORT || '3009', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Invalid tool names negative test server running on http://localhost:${PORT}/mcp`
  );
});
