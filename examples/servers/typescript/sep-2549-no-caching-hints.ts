#!/usr/bin/env node

/**
 * SEP-2549 Negative Test Server
 *
 * Speaks the stateless draft wire protocol (SEP-2575) but returns list and
 * read results WITHOUT ttlMs and cacheScope fields, violating the SEP-2549
 * MUST. The caching scenario should emit FAILURE for presence checks against
 * this server.
 */

import express from 'express';

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method;

  // Deliberately omit ttlMs and cacheScope from every result below.
  switch (method) {
    case 'server/discover':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['DRAFT-2026-v1'],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'sep-2549-no-caching-hints', version: '1.0.0' }
        }
      });
    case 'tools/list':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'test_tool',
              description: 'A test tool',
              inputSchema: { type: 'object' }
            }
          ]
        }
      });
    case 'prompts/list':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          prompts: [{ name: 'test_prompt', description: 'A test prompt' }]
        }
      });
    case 'resources/list':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'test://static-text',
              name: 'Static Text',
              description: 'A static text resource'
            }
          ]
        }
      });
    case 'resources/templates/list':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { resourceTemplates: [] }
      });
    case 'resources/read':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'test://static-text',
              mimeType: 'text/plain',
              text: 'Static text content.'
            }
          ]
        }
      });
    default:
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
  }
});

const PORT = parseInt(process.env.PORT || '3006', 10);
app.listen(PORT, () => {
  console.log(
    `SEP-2549 negative test server running on http://localhost:${PORT}/mcp`
  );
});
