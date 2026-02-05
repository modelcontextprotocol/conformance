#!/usr/bin/env node

/**
 * A minimal MCP server built without the SDK.
 *
 * Implements just enough of the protocol to pass basic conformance tests:
 * initialize, tools/list, tools/call (with progress notifications).
 *
 * Uses a per-session architecture with session IDs, but keeps an in-flight
 * request table to route notifications back to the correct SSE stream.
 */

import { randomUUID } from 'crypto';
import express from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  initialized: boolean;
}

interface InFlightRequest {
  streamWriter: (event: string, data: string) => void;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();

// Track in-flight requests so we can send notifications (progress, logging)
// back on the correct SSE stream while a tool is still executing.
//
// Key: JSON-RPC request id (number | string)
// Value: the SSE writer + session context for that request
const inFlightRequests = new Map<number | string, InFlightRequest>();

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function handleToolCall(
  toolName: string,
  _args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  requestId: number | string
): Promise<object> {
  switch (toolName) {
    case 'test_simple_text':
      return {
        content: [
          { type: 'text', text: 'This is a simple text response for testing.' }
        ]
      };

    case 'test_image_content':
      return {
        content: [
          { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }
        ]
      };

    case 'test_tool_with_progress': {
      const progressToken = meta?.progressToken ?? 0;

      for (let i = 0; i <= 2; i++) {
        // Look up the stream for this request on each iteration
        const entry = inFlightRequests.get(requestId);
        if (entry) {
          const notification = {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: i * 50,
              total: 100
            }
          };
          entry.streamWriter('message', JSON.stringify(notification));
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      return {
        content: [{ type: 'text', text: String(progressToken) }]
      };
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${toolName}`), {
        code: -32601
      });
  }
}

const TOOLS = [
  {
    name: 'test_simple_text',
    description: 'Tests simple text content response',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'test_image_content',
    description: 'Tests image content response',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'test_tool_with_progress',
    description: 'Tests tool that reports progress notifications',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ---------------------------------------------------------------------------
// JSON-RPC message handling
// ---------------------------------------------------------------------------

function handleMessage(
  message: any,
  session: Session,
  sseWriter: (event: string, data: string) => void
): Promise<void> | undefined {
  // Notification (no id) — fire and forget
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized') {
      session.initialized = true;
    }
    return;
  }

  const requestId = message.id;

  switch (message.method) {
    case 'initialize': {
      const response = {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, logging: {} },
          serverInfo: { name: 'naive-shared-state-server', version: '1.0.0' }
        }
      };
      sseWriter('message', JSON.stringify(response));
      return;
    }

    case 'tools/list': {
      sseWriter(
        'message',
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          result: { tools: TOOLS }
        })
      );
      return;
    }

    case 'tools/call': {
      const toolName = message.params?.name;
      const toolArgs = message.params?.arguments ?? {};
      const meta = message.params?._meta;

      // Register this request so in-flight notifications can find its stream
      inFlightRequests.set(requestId, {
        streamWriter: sseWriter,
        sessionId: session.id
      });

      // Return a promise that resolves when the tool handler is done.
      // The caller uses this to know when to close the SSE stream.
      return handleToolCall(toolName, toolArgs, meta, requestId)
        .then((result) => {
          // Send final response directly on this request's own sseWriter,
          // NOT through the inFlightRequests map (final response is always
          // routed correctly since we captured sseWriter at request time)
          sseWriter(
            'message',
            JSON.stringify({ jsonrpc: '2.0', id: requestId, result })
          );
        })
        .catch((err) => {
          sseWriter(
            'message',
            JSON.stringify({
              jsonrpc: '2.0',
              id: requestId,
              error: {
                code: err.code ?? -32603,
                message: err.message ?? 'Internal error'
              }
            })
          );
        })
        .finally(() => {
          inFlightRequests.delete(requestId);
        });
    }

    case 'ping': {
      sseWriter(
        'message',
        JSON.stringify({ jsonrpc: '2.0', id: requestId, result: {} })
      );
      return;
    }

    default: {
      sseWriter(
        'message',
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`
          }
        })
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
  const body = req.body;

  // Resolve or create session
  let session: Session;

  if (sessionIdHeader && sessions.has(sessionIdHeader)) {
    session = sessions.get(sessionIdHeader)!;
  } else if (!sessionIdHeader && body?.method === 'initialize') {
    session = { id: randomUUID(), initialized: false };
    sessions.set(session.id, session);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: body?.id ?? null
    });
    return;
  }

  // Set up SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Mcp-Session-Id': session.id
  });

  const sseWriter = (event: string, data: string) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    }
  };

  // Handle the message(s)
  const messages = Array.isArray(body) ? body : [body];
  const promises: Promise<void>[] = [];

  for (const message of messages) {
    const p = handleMessage(message, session, sseWriter);
    if (p) promises.push(p);
  }

  if (promises.length > 0) {
    // Wait for all async handlers (tool calls) to complete
    await Promise.all(promises);
  }

  res.end();
});

const PORT = parseInt(process.env.PORT || '3007', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`MCP server running on http://localhost:${PORT}/mcp`);
});
