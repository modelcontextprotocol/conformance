#!/usr/bin/env node

/**
 * MCP Server WITHOUT DNS Rebinding Protection - Negative Test Case
 *
 * This is the simplest possible vulnerable server to demonstrate what happens
 * when DNS rebinding protection is omitted. DO NOT use this pattern in production.
 *
 * This server should FAIL the dns-rebinding-protection conformance scenario.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';

// Create minimal MCP server
const server = new McpServer({
  name: 'no-dns-rebinding-protection-server',
  version: '1.0.0'
});

// Add a simple tool
server.tool(
  'echo',
  'Echo the input back',
  { message: { type: 'string' } },
  async ({ message }) => ({
    content: [{ type: 'text', text: `Echo: ${message}` }]
  })
);

// === VULNERABLE EXPRESS APP ===
// This intentionally does NOT use createMcpExpressApp() or localhostHostValidation()
const app = express();
app.use(express.json());
// NO DNS rebinding protection middleware here!

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && req.body?.method === 'initialize') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session' },
      id: null
    });
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

const PORT = parseInt(process.env.PORT || '3003', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Vulnerable server running on http://localhost:${PORT}/mcp`);
  console.log(`WARNING: No DNS rebinding protection enabled!`);
});
