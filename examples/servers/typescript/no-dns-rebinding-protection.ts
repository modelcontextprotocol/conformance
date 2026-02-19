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

// Create a fresh MCP server per request to avoid "Already connected" errors
// after the v1.26.0 security fix (GHSA-345p-7cg4-v4c7)
function createMcpServer() {
  const server = new McpServer({
    name: 'no-dns-rebinding-protection-server',
    version: '1.0.0'
  });

  server.registerTool(
    'echo',
    {
      description: 'Echo the input back',
      inputSchema: { message: { type: 'string' } }
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }]
    })
  );

  return server;
}

// === VULNERABLE EXPRESS APP ===
// This intentionally does NOT use createMcpExpressApp() or localhostHostValidation()
const app = express();
app.use(express.json());
// NO DNS rebinding protection middleware here!

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

const PORT = parseInt(process.env.PORT || '3003', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Vulnerable server running on http://localhost:${PORT}/mcp`);
  console.log(`WARNING: No DNS rebinding protection enabled!`);
});
