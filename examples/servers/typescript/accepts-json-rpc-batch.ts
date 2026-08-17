#!/usr/bin/env node

/**
 * Negative test server that incorrectly accepts JSON-RPC batch arrays.
 *
 * AGENTS.md negative-fixture pattern: deliberately broken server in
 * examples/servers/typescript/, exercised from negative.test.ts (not
 * everything-server). Proves json-rpc-batch-rejected emits FAILURE when a
 * server returns 200 with a batch response array.
 */

import express from 'express';

function handleSingle(body: {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const id = body.id ?? null;
  const method = body.method;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0' as const,
        id,
        result: {
          protocolVersion:
            (body.params?.protocolVersion as string | undefined) ??
            '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'accepts-json-rpc-batch', version: '1.0.0' }
        }
      };
    case 'ping':
      return { jsonrpc: '2.0' as const, id, result: {} };
    case 'server/discover':
      return {
        jsonrpc: '2.0' as const,
        id,
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: {},
          serverInfo: { name: 'accepts-json-rpc-batch', version: '1.0.0' }
        }
      };
    case 'tools/list':
      return {
        jsonrpc: '2.0' as const,
        id,
        result: { tools: [] }
      };
    default:
      return {
        jsonrpc: '2.0' as const,
        id,
        error: { code: -32601, message: 'Method not found' }
      };
  }
}

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  const body = req.body;

  if (Array.isArray(body)) {
    const responses = body.map((item) =>
      handleSingle(
        typeof item === 'object' && item !== null
          ? (item as {
              id?: number | string | null;
              method?: string;
              params?: Record<string, unknown>;
            })
          : { id: null }
      )
    );
    return res.status(200).json(responses);
  }

  return res.json(handleSingle(body ?? {}));
});

const PORT = parseInt(process.env.PORT || '3008', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `JSON-RPC batch acceptance negative test server running on http://localhost:${PORT}/mcp`
  );
});
