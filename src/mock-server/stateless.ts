/**
 * Stateless mock server: 2026-x lifecycle (SEP-2575).
 *
 * No initialize handshake. Validates `_meta` (protocolVersion / clientInfo /
 * clientCapabilities) and the `MCP-Protocol-Version` header on every request,
 * serves `server/discover`, and routes other methods to the supplied handlers.
 * Implemented with raw express so it can front-run SDK support.
 */

import express from 'express';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import type { JSONRPCRequest } from '../spec-types/2025-11-25';
import type { MockServer, MockServerOptions, RequestHandlers } from './index';

const META_KEYS = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities'
] as const;

export async function createServerStateless(
  handlers: RequestHandlers,
  opts: MockServerOptions = {}
): Promise<MockServer> {
  const recorded: JSONRPCRequest[] = [];
  const capabilities = opts.capabilities ?? { tools: {} };

  const app = express();
  app.use(express.json());
  opts.configure?.(app);

  app.post('/mcp', async (req, res) => {
    const body = req.body ?? {};
    const id = body.id ?? null;
    const method: string = body.method;
    const params = (body.params ?? {}) as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown> | undefined;

    const error = (status: number, code: number, message: string) =>
      res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });

    const headerVersion = req.headers['mcp-protocol-version'];
    if (!headerVersion) {
      return error(400, -32001, 'Missing MCP-Protocol-Version header');
    }
    const missing = META_KEYS.filter((k) => meta?.[k] === undefined);
    if (missing.length > 0) {
      return error(
        400,
        -32602,
        `Invalid params: missing _meta keys: ${missing.join(', ')}`
      );
    }
    if (meta?.[META_KEYS[0]] !== headerVersion) {
      return error(
        400,
        -32001,
        'MCP-Protocol-Version header does not match _meta.protocolVersion'
      );
    }

    if (method === 'server/discover') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [DRAFT_PROTOCOL_VERSION],
          capabilities,
          serverInfo: { name: 'conformance-mock-server', version: '1.0.0' }
        }
      });
    }

    recorded.push(body as JSONRPCRequest);

    const handler = handlers[method];
    if (!handler) {
      return error(404, -32601, `Method not found: ${method}`);
    }
    try {
      const result = await handler(params, body as JSONRPCRequest);
      return res.json({ jsonrpc: '2.0', id, result });
    } catch (e) {
      return error(500, -32603, e instanceof Error ? e.message : String(e));
    }
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(0);
    httpServer.on('error', reject);
    httpServer.on('listening', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;
      resolve({
        url: `${baseUrl}/mcp`,
        baseUrl,
        recorded,
        close: () =>
          new Promise<void>((r) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => r());
          })
      });
    });
  });
}
