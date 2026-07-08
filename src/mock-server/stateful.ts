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
import { LATEST_SPEC_VERSION, type SpecVersion } from '../types';
import { validateWireMessage } from '../validation/wire-schema';
import type { MockServer, RequestHandlers } from './index';

const CAPABILITY_BY_PREFIX: Record<string, string> = {
  tools: 'tools',
  prompts: 'prompts',
  resources: 'resources',
  completion: 'completions',
  logging: 'logging'
};

/**
 * Derive the server `capabilities` object from the registered handler method
 * names so the SDK's `assertRequestHandlerCapability` gate is always satisfied.
 * Shared with the stateless impl for `server/discover`.
 */
export function capabilitiesFromHandlers(
  handlers: RequestHandlers
): Record<string, object> {
  const out: Record<string, object> = {};
  for (const method of Object.keys(handlers)) {
    const cap = CAPABILITY_BY_PREFIX[method.split('/')[0]];
    if (cap) out[cap] = {};
  }
  return out;
}

export async function createServerStateful(
  handlers: RequestHandlers,
  specVersion: SpecVersion = LATEST_SPEC_VERSION
): Promise<MockServer> {
  const recorded: JSONRPCRequest[] = [];
  const capabilities = capabilitiesFromHandlers(handlers);

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
        try {
          const result = (await handler(
            (request.params ?? {}) as Record<string, unknown>,
            request as JSONRPCRequest
          )) as Record<string, unknown>;
          // The SDK builds the response envelope; validate the
          // harness-authored result against its typed definition.
          validateWireMessage(
            specVersion,
            { jsonrpc: '2.0', id: 0, result },
            {
              origin: 'harness',
              context: `stateful mock result for '${method}'`,
              requestMethod: method
            }
          );
          return result;
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

  app.post('/mcp', async (req, res) => {
    // Record every JSON-RPC request the client sends (excluding the lifecycle
    // preamble) at the HTTP layer so unregistered methods are captured too,
    // matching the stateless impl and the MockServer.recorded contract.
    const body = req.body;
    validateWireMessage(specVersion, body, {
      origin: 'implementation',
      context: `client request '${body?.method ?? '(unknown)'}' to stateful mock`
    });
    if (
      body?.method &&
      body.method !== 'initialize' &&
      body.method !== 'notifications/initialized'
    ) {
      recorded.push(body as JSONRPCRequest);
    }
    try {
      const server = newServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);
      // Register cleanup before handing the request to the transport so the
      // pair is torn down even when handleRequest throws.
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await transport.handleRequest(req, res, req.body);
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
