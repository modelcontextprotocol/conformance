#!/usr/bin/env node

/**
 * MCP Server that validates the Origin header but not the Host header -
 * Negative Test Case
 *
 * Returns 403 for a present, non-localhost Origin, as the Streamable HTTP
 * transport requires, but accepts any Host. A request with a forged Host and
 * no Origin is accepted.
 *
 * Expected dns-rebinding-protection results:
 * - localhost-host-rebinding-rejected: SUCCESS (Origin is forged too)
 * - localhost-host-only-rebinding-rejected: WARNING (no 4xx)
 * - localhost-origin-only-rebinding-rejected: SUCCESS
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';

function createMcpServer() {
  const server = new McpServer({
    name: 'dns-rebinding-origin-only-server',
    version: '1.0.0'
  });

  server.registerTool(
    'echo',
    {
      description: 'Echo the input back',
      inputSchema: { message: z.string() }
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }]
    })
  );

  return server;
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

// Plain express app: no Host validation.
const app = express();
app.use(express.json());

// Origin validation only.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === undefined || isLocalhostOrigin(origin)) {
    next();
    return;
  }
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: `Invalid Origin: ${origin}` },
    id: null
  });
});

app.post('/mcp', async (req, res) => {
  try {
    const server = createMcpServer();
    // Stateless: no session ID
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

const PORT = parseInt(process.env.PORT || '3012', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Origin-only server running on http://localhost:${PORT}/mcp`);
});
