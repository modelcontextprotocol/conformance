#!/usr/bin/env node

/**
 * Negative test server for spec Tool Names SHOULD rules (2025-11-25+).
 *
 * AGENTS.md negative-fixture pattern: bypass SDK registerTool validation via
 * setRequestHandler(ListToolsRequestSchema) so tools/list advertises a name
 * that violates core spec prose at #tool-names. Proves tools-name-format emits
 * WARNING (SHOULD-level per AGENTS.md), not FAILURE. everything-server unchanged.
 *
 * ## Why this file is not named after SEP-986
 *
 * Tool name format rules trace to [SEP-986](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)
 * (opened 2025-07-16), but the **authoritative rules live in dated spec prose**,
 * not the SEP markdown artifact. That split is a process wart worth preserving:
 *
 * - **SEP-986 markdown** (`seps/986-specify-format-for-tool-names.md`) still
 *   documents stale rules: 1–64 chars, `[A-Za-z0-9_./-]` including `/`. The
 *   finalized SEP file was **never updated** after spec integration.
 * - **Integrated spec** ([PR #1603](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1603),
 *   Oct 2025) landed different prose in draft, then **2025-11-25** `#tool-names`:
 *   1–128 chars, `[A-Za-z0-9_.-]` only (no `/`).
 * - **Conformance #240** incorrectly encoded the stale SEP markdown (64 + `/`,
 *   FAILURE severity). This suite follows the integrated spec diff per AGENTS.md;
 *   see `tools.ts` block comment and `specReferences` (core URLs first, SEP links
 *   context-only). There is intentionally **no `sep-986.yaml`** traceability row.
 *
 * Naming the fixture after the SEP would imply traceability we deliberately
 * declined — and would obscure that the SEP artifact and published spec diverged.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

function createServer() {
  const server = new Server(
    { name: 'invalid-tool-names', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'bad tool name',
        description: 'Deliberately invalid tool name for conformance testing',
        inputSchema: { type: 'object' }
      },
      {
        name: 'valid_tool',
        description: 'A conformant tool name',
        inputSchema: { type: 'object' }
      }
    ]
  }));

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
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

const PORT = parseInt(process.env.PORT || '3009', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Invalid tool names negative test server running on http://localhost:${PORT}/mcp`
  );
});
