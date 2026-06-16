#!/usr/bin/env node

/**
 * SEP-2164 Negative Test Server
 *
 * Speaks the stateless wire protocol (SEP-2575) but returns an empty
 * contents array for any resources/read request, violating the SEP-2164 MUST
 * NOT. The sep-2164-resource-not-found scenario should emit FAILURE for
 * sep-2164-no-empty-contents against this server.
 */

import express from 'express';

const app = express();
app.use(express.json());

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
          supportedVersions: ['2026-07-28'],
          capabilities: { resources: {} },
          serverInfo: { name: 'sep-2164-empty-contents', version: '1.0.0' }
        }
      });
    case 'resources/list':
      return res.json({ jsonrpc: '2.0', id, result: { resources: [] } });
    case 'resources/read':
      // Deliberately return an empty contents array instead of an error.
      return res.json({ jsonrpc: '2.0', id, result: { contents: [] } });
    default:
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
  }
});

const PORT = parseInt(process.env.PORT || '3005', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `SEP-2164 negative test server running on http://localhost:${PORT}/mcp`
  );
});
