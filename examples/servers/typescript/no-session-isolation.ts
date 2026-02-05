#!/usr/bin/env node

/**
 * MCP Server WITHOUT Session Isolation - Negative Test Case
 *
 * This server is intentionally vulnerable to CWE-362 message ID collision.
 * It uses a SINGLE SHARED StreamableHTTPServerTransport with sessionIdGenerator
 * set to undefined (stateless mode). When two concurrent clients send requests
 * with the same JSON-RPC message ID, the server's internal _requestToStreamMapping
 * will overwrite entries, causing responses to be routed to the wrong client.
 *
 * DO NOT use this pattern in production. This exists solely for negative
 * conformance testing of the session-isolation scenario.
 *
 * This server should FAIL the session-isolation conformance test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

// Sample base64 encoded 1x1 red PNG pixel for testing
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Create a single MCP server instance
const server = new McpServer({
  name: 'no-session-isolation-server',
  version: '1.0.0'
});

// Register tools identical to the everything-server, with deliberate timing
// to produce cross-talk (not just a stolen slot).
//
// The conformance test sends test_simple_text (Client A) first, then
// test_image_content (Client B) 100ms later. With these delays:
//
//   T=0ms:   A arrives → mapping.set(2, streamA), tool starts (150ms)
//   T=100ms: B arrives → mapping.set(2, streamB) ← OVERWRITES A's entry
//   T=150ms: A's tool returns → mapping.get(2) → streamB → A's text response
//            is written to B's HTTP stream. B receives A's data = CROSS-TALK.
//   T=600ms: B's tool returns → mapping.get(2) → gone → error, A gets nothing.
//
// Result: B sees content type "text" instead of "image" — actual cross-talk.
server.tool(
  'test_simple_text',
  'Tests simple text content response',
  {},
  async () => {
    // Slow enough for B to overwrite the mapping, but finishes before B's tool
    await new Promise((r) => setTimeout(r, 150));
    return {
      content: [
        { type: 'text', text: 'This is a simple text response for testing.' }
      ]
    };
  }
);

server.registerTool(
  'test_image_content',
  {
    description: 'Tests image content response'
  },
  async () => {
    // Finishes after A, so A's response is routed first (to B's stream)
    await new Promise((r) => setTimeout(r, 500));
    return {
      content: [
        { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }
      ]
    };
  }
);

// === VULNERABLE SERVER SETUP ===
// Single shared transport with NO session management.
// This causes message ID collisions between concurrent clients.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined
});

// Connect the server to the single shared transport once
await server.connect(transport);

const app = express();
app.use(express.json());

// Route ALL requests through the single shared transport
app.post('/mcp', async (req, res) => {
  try {
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

const PORT = parseInt(process.env.PORT || '3005', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Vulnerable server (no session isolation) running on http://localhost:${PORT}/mcp`
  );
  console.log(
    'WARNING: This server uses a single shared transport without session management!'
  );
  console.log(
    'It is intentionally vulnerable to CWE-362 message ID collision.'
  );
});
