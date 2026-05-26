/**
 * Stateful mock server: 2025-x lifecycle (initialize handshake).
 *
 * Backed by the SDK's `Server` + `StreamableHTTPServerTransport` so we don't
 * reimplement the handshake or SSE response framing. The SDK is the scaffold
 * here, not the system-under-test; the client-under-test connecting to this
 * mock is what's being verified.
 */

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { JSONRPCRequest } from '../spec-types/2025-11-25';
import type { MockServer, MockServerOptions, RequestHandlers } from './index';

export async function createServerStateful(
  handlers: RequestHandlers,
  opts: MockServerOptions = {}
): Promise<MockServer> {
  const recorded: JSONRPCRequest[] = [];
  const capabilities = opts.capabilities ?? { tools: {} };

  // Fresh SDK Server per HTTP request (the SDK transport is single-shot in
  // sessionless mode after GHSA-345p-7cg4-v4c7).
  function newServer(): Server {
    const server = new Server(
      { name: 'conformance-mock-server', version: '1.0.0' },
      { capabilities }
    );
    for (const [method, handler] of Object.entries(handlers)) {
      // The SDK's setRequestHandler matches by parsing against the schema's
      // method literal; build a minimal schema so any method string works.
      const schema = z.object({
        method: z.literal(method),
        params: z.unknown().optional()
      });
      server.setRequestHandler(schema, async (request) => {
        recorded.push(request as JSONRPCRequest);
        try {
          return (await handler(
            (request.params ?? {}) as Record<string, unknown>,
            request as JSONRPCRequest
          )) as Record<string, unknown>;
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw new McpError(
            ErrorCode.InternalError,
            e instanceof Error ? e.message : String(e)
          );
        }
      });
    }
    return server;
  }

  const app = express();
  app.use(express.json());
  opts.configure?.(app);

  app.post('/mcp', async (req, res) => {
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? null,
          error: { code: -32603, message: String(e) }
        });
      }
    }
  });

  return listen(app, recorded);
}

function listen(
  app: express.Application,
  recorded: JSONRPCRequest[]
): Promise<MockServer> {
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
          new Promise<void>((res) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => res());
          })
      });
    });
  });
}
