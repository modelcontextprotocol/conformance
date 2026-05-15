#!/usr/bin/env node

/**
 * SEP-2322 Negative Test Server
 *
 * This server advertises the same tools as the MRTR reference server but
 * returns normal complete results instead of InputRequiredResult. This lets
 * negative tests verify that the conformance checks correctly emit FAILURE
 * when a server doesn't actually implement the MRTR flow.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  StreamableHTTPServerTransport,
  EventStore,
  EventId,
  StreamId
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'crypto';

// ─── In-Memory Event Store for SSE ──────────────────────────────────────────

class InMemoryEventStore implements EventStore {
  private events: Map<string, { streamId: string; message: string }> =
    new Map();
  private counter = 0;

  async storeEvent(
    streamId: StreamId,
    message: string
  ): Promise<EventId> {
    const id = String(++this.counter);
    this.events.set(id, { streamId: streamId as string, message });
    return id as EventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send
    }: { send: (eventId: EventId, message: string) => void }
  ): Promise<string> {
    const start = parseInt(lastEventId as string, 10) || 0;
    for (const [id, evt] of this.events) {
      if (parseInt(id, 10) > start) {
        send(id as EventId, evt.message);
      }
    }
    return (this.events.size > 0
      ? String(this.counter)
      : (lastEventId as string)) as string;
  }
}

function createServer(): Server {
  const server = new Server(
    { name: 'sep-2322-no-mrtr', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        prompts: {}
      }
    }
  );

  // ─── Tools: list ────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'test_input_required_result_elicitation',
        description: 'Returns a normal result (no MRTR)',
        inputSchema: { type: 'object' as const, properties: {} }
      }
    ]
  }));

  // ─── Tools: call — always returns a complete result ─────────────────
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'Done (no input required)' }]
  }));

  // ─── Prompts: list ──────────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'test_input_required_result_prompt',
        description: 'Returns a normal prompt result (no MRTR)'
      }
    ]
  }));

  // ─── Prompts: get — always returns a complete result ────────────────
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [
      {
        role: 'assistant' as const,
        content: { type: 'text' as const, text: 'Normal response, no MRTR.' }
      }
    ]
  }));

  return server;
}

// ─── HTTP transport ────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3011', 10);
const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'POST') {
    const eventStore = new InMemoryEventStore();
    const server = createServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      }
    });

    transport.onclose = () => {
      const sid = (transport as unknown as { sessionId?: string }).sessionId;
      if (sid) transports.delete(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'No valid session' });
  }
});

app.listen(PORT, () => {
  console.log(`sep-2322-no-mrtr server running on http://localhost:${PORT}/mcp`);
});
