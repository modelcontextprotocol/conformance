#!/usr/bin/env node

/**
 * tools-call-protocol-error negative test server.
 *
 * Speaks the stateless wire (SEP-2575) and breaks the two rules the
 * tools-call-protocol-error scenario exists to catch: a tools/call for a
 * tool it does not have is answered with a CallToolResult carrying
 * `isError: true` instead of a JSON-RPC error response, and every response
 * id is emitted as a string, so a numeric request id comes back coerced.
 * The tools/list result is otherwise well formed.
 */

import express from 'express';

const app = express();
app.use(express.json());

const caching = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' };

app.post('/mcp', (req, res) => {
  const body = req.body || {};
  // Deliberate defect: ids are stringified on the way out.
  const id = body.id === undefined || body.id === null ? null : String(body.id);
  switch (body.method) {
    case 'server/discover':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          ...caching,
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: {
            name: 'tools-call-unknown-tool-as-result',
            version: '1.0.0'
          }
        }
      });
    case 'tools/list':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { ...caching, tools: [] }
      });
    case 'tools/call':
      // Deliberate defect: an unknown tool reported as a tool execution error.
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          ...caching,
          isError: true,
          content: [
            { type: 'text', text: `Unknown tool: ${body.params?.name}` }
          ]
        }
      });
    default:
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${body.method}` }
      });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(
    `tools-call-unknown-tool-as-result server running on http://localhost:${port}/mcp`
  );
});
