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

// Barrier to ensure both tool calls are in-flight before either returns.
// The first tool to arrive waits for the second, then both return together.
// This guarantees the _requestToStreamMapping collision happens deterministically.
let barrierResolve: (() => void) | null = null;
const barrier = new Promise<void>((resolve) => {
  barrierResolve = resolve;
});
let arrivedCount = 0;

async function waitForBothToolCalls(): Promise<void> {
  arrivedCount++;
  if (arrivedCount >= 2) {
    // Second tool arrived -- release the barrier so both proceed
    barrierResolve!();
  } else {
    // First tool arrived -- wait for the second
    await barrier;
  }
}

// Register tools identical to the everything-server, but each waits at the
// barrier so both requests are guaranteed to be in-flight concurrently.
server.tool(
  'test_simple_text',
  'Tests simple text content response',
  {},
  async () => {
    await waitForBothToolCalls();
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
    await waitForBothToolCalls();
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
