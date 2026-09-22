#!/usr/bin/env node

/**
 * tools/list ordering negative test server.
 *
 * Speaks the sessionless 2026-07-28 wire (SEP-2575) and advertises the same
 * four tools on every tools/list request, but rotates the list by one
 * position each time (it keeps a call counter for that, nothing else). The set never changes, only the order, which violates the
 * 2026-07-28 SHOULD "Servers SHOULD return tools in a deterministic order".
 * The tools-list scenario should emit WARNING for
 * tools-list-deterministic-order against this server while tools-list itself
 * still passes, since every response is structurally valid.
 */

import express from 'express';

const app = express();
app.use(express.json());

const TOOLS = ['alpha', 'bravo', 'charlie', 'delta'].map((name) => ({
  name,
  description: `Fixture tool ${name}`,
  inputSchema: { type: 'object', properties: {} }
}));

let listCalls = 0;

app.post('/mcp', (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method;

  switch (method) {
    case 'server/discover':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: { name: 'tools-list-rotated-order', version: '1.0.0' }
        }
      });
    case 'tools/list': {
      // Rotate by one position per call: the same set, never the same order.
      const offset = listCalls++ % TOOLS.length;
      const tools = [...TOOLS.slice(offset), ...TOOLS.slice(0, offset)];
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools
        }
      });
    }
    default:
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
  }
});

const PORT = parseInt(process.env.PORT || '3008', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `tools/list rotated-order negative test server running on http://localhost:${PORT}/mcp`
  );
});
