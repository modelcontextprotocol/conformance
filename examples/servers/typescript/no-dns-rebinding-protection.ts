#!/usr/bin/env node

/**
 * MCP Server WITHOUT DNS Rebinding Protection - Negative Test Case
 *
 * This server intentionally omits DNS rebinding protection to demonstrate
 * what a vulnerable server looks like. DO NOT use this pattern in production.
 *
 * This is a negative test case for the conformance suite - it should FAIL
 * the dns-rebinding-protection scenario.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport,
  EventStore,
  EventId,
  StreamId
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';

// In-memory event store for SSE
function createEventStore(): EventStore {
  const events = new Map<StreamId, Map<EventId, string>>();

  return {
    async storeEvent(
      streamId: StreamId,
      eventId: EventId,
      message: string
    ): Promise<void> {
      if (!events.has(streamId)) {
        events.set(streamId, new Map());
      }
      events.get(streamId)!.set(eventId, message);
    },
    async replayEventsAfter(
      streamId: StreamId,
      lastEventId: EventId
    ): Promise<string[]> {
      const streamEvents = events.get(streamId);
      if (!streamEvents) {
        return [];
      }
      const entries = Array.from(streamEvents.entries()).sort(
        ([a], [b]) => Number(a) - Number(b)
      );
      const startIdx = entries.findIndex(([id]) => id === lastEventId);
      if (startIdx === -1) {
        return entries.map(([, msg]) => msg);
      }
      return entries.slice(startIdx + 1).map(([, msg]) => msg);
    }
  };
}

// Create MCP server with minimal functionality
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'no-dns-rebinding-protection-server',
    version: '1.0.0'
  });

  // Add a simple tool
  server.tool(
    'echo',
    'Echo the input back',
    { message: { type: 'string', description: 'Message to echo' } },
    async ({ message }) => {
      return {
        content: [{ type: 'text', text: `Echo: ${message}` }]
      };
    }
  );

  return server;
}

// Track active transports and servers
const transports: Record<string, StreamableHTTPServerTransport> = {};
const servers: Record<string, McpServer> = {};

function isInitializeRequest(body: any): boolean {
  return body?.method === 'initialize';
}

// === VULNERABLE EXPRESS APP ===
// This intentionally does NOT use createMcpExpressApp() or localhostHostValidation()
// to demonstrate a server without DNS rebinding protection.

const app = express();
app.use(express.json());

// NO DNS rebinding protection middleware here!
// This is intentionally vulnerable for testing purposes.

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const mcpServer = createMcpServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: createEventStore(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = mcpServer;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            delete servers[sid];
          }
        }
      };

      await mcpServer.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      });
    }
  }
});

// Start server
const PORT = parseInt(process.env.PORT || '3003', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Vulnerable server running on http://localhost:${PORT}`);
  console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  - WARNING: No DNS rebinding protection enabled!`);
});
