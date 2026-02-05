#!/usr/bin/env node

/**
 * MCP Server WITHOUT Notification Isolation - Negative Test Case (Issue 2)
 *
 * This server is intentionally vulnerable to GHSA-345p-7cg4-v4c7 Issue 2:
 * it creates a new transport per request but shares a single McpServer instance.
 * Each call to server.connect(transport) overwrites this._transport, causing
 * in-request notifications (progress, logging) to be routed to the wrong client.
 *
 * This mimics the pattern used by Cloudflare's createMcpHandler (stateless Workers path).
 *
 * DO NOT use this pattern in production. This exists solely for negative
 * conformance testing of the notification-isolation scenario.
 *
 * This server should FAIL the notification-isolation conformance test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

// Sample base64 encoded 1x1 red PNG pixel for testing
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// === VULNERABLE: Single shared McpServer across all requests ===
const server = new McpServer(
  {
    name: 'no-notification-isolation-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    }
  }
);

// Simple text tool (no delay)
server.tool(
  'test_simple_text',
  'Tests simple text content response',
  {},
  async () => {
    return {
      content: [
        { type: 'text', text: 'This is a simple text response for testing.' }
      ]
    };
  }
);

// Image content tool (no delay)
server.registerTool(
  'test_image_content',
  { description: 'Tests image content response' },
  async () => {
    return {
      content: [
        { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }
      ]
    };
  }
);

// Tool with progress notifications — the key tool for Issue 2 testing.
// Sends progress notifications via sendNotification which goes through
// this._transport (the vulnerable path).
server.registerTool(
  'test_tool_with_progress',
  {
    description: 'Tests tool that reports progress notifications',
    inputSchema: {}
  },
  async (_args, { sendNotification, _meta }) => {
    const progressToken = _meta?.progressToken ?? 0;

    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: 0,
        total: 100,
        message: `Completed step 0 of 100`
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: 50,
        total: 100,
        message: `Completed step 50 of 100`
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: 100,
        total: 100,
        message: `Completed step 100 of 100`
      }
    });

    return {
      content: [{ type: 'text', text: String(progressToken) }]
    };
  }
);

const app = express();
app.use(express.json());

// === VULNERABLE PATTERN ===
// New transport per request, but server.connect() overwrites this._transport
// on the shared server. This is the pattern used by Cloudflare's createMcpHandler.
app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    // This overwrites this._transport on the shared server!
    // If another request is in-flight, its in-request notifications
    // will now be routed through this new transport instead.
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
    `Vulnerable server (no notification isolation) running on http://localhost:${PORT}/mcp`
  );
  console.log(
    'WARNING: Shared McpServer with per-request transports — vulnerable to Issue 2!'
  );
  console.log(
    'In-request notifications will be routed through the last-connected transport.'
  );
});
