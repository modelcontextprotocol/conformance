#!/usr/bin/env node

/**
 * MCP Server that validates the Host header but not the Origin header -
 * Negative Test Case
 *
 * Uses createMcpExpressApp(), whose localhost default in SDK 1.x validates
 * Host only. A request with a valid Host and a foreign Origin is accepted.
 *
 * Expected dns-rebinding-protection results:
 * - localhost-host-rebinding-rejected: SUCCESS (Host is forged too)
 * - localhost-host-only-rebinding-rejected: SUCCESS
 * - localhost-origin-only-rebinding-rejected: FAILURE (no 403)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';

function createMcpServer() {
  const server = new McpServer({
    name: 'dns-rebinding-host-only-server',
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

// Host validation only; no Origin check.
const app = createMcpExpressApp();

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

const PORT = parseInt(process.env.PORT || '3010', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Host-only server running on http://localhost:${PORT}/mcp`);
});
