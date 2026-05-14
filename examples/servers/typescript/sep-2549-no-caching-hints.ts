#!/usr/bin/env node

/**
 * SEP-2549 Negative Test Server
 *
 * Returns list and read results WITHOUT ttlMs and cacheScope fields,
 * violating the SEP-2549 MUST. The caching scenario should emit FAILURE
 * for presence checks against this server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'crypto';

const transports: Record<string, StreamableHTTPServerTransport> = {};

function isInitializeRequest(body: any): boolean {
  return body?.method === 'initialize';
}

function createServer() {
  const server = new Server(
    { name: 'sep-2549-no-caching-hints', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    }
  );

  // Deliberately omit ttlMs and cacheScope from all responses
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const }
      }
    ]
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'test_prompt',
        description: 'A test prompt'
      }
    ]
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'test://static-text',
        name: 'Static Text',
        description: 'A static text resource'
      }
    ]
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: []
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [
      {
        uri: 'test://static-text',
        mimeType: 'text/plain',
        text: 'Static text content.'
      }
    ]
  }));

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        }
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
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

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Invalid or missing session ID' });
  }
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Invalid or missing session ID' });
  }
});

const PORT = parseInt(process.env.PORT || '3006', 10);
app.listen(PORT, () => {
  console.log(
    `SEP-2549 negative test server running on http://localhost:${PORT}/mcp`
  );
});
