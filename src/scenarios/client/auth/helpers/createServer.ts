import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express, { Request, Response, NextFunction } from 'express';
import type { ConformanceCheck } from '../../../../types.js';
import { createRequestLogger } from '../../../request-logger.js';
import { MockTokenVerifier } from './mockTokenVerifier.js';
import { SpecReferences } from '../spec-references.js';

export interface ServerOptions {
  prmPath?: string | null;
}

export function createServer(
  checks: ConformanceCheck[],
  getBaseUrl: () => string,
  getAuthServerUrl: () => string,
  options: ServerOptions = {}
): express.Application {
  const { prmPath = '/.well-known/oauth-protected-resource/mcp' } = options;
  const server = new Server(
    {
      name: 'auth-prm-pathbased-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: []
    };
  });

  const app = express();
  app.use(express.json());

  app.use(
    createRequestLogger(checks, {
      incomingId: 'incoming-request',
      outgoingId: 'outgoing-response',
      mcpRoute: '/mcp'
    })
  );

  if (prmPath !== null) {
    app.get(prmPath, (req: Request, res: Response) => {
      checks.push({
        id: 'prm-pathbased-requested',
        name: 'PRMPathBasedRequested',
        description: 'Client requested PRM metadata at path-based location',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_PRM_DISCOVERY,
          SpecReferences.MCP_PRM_DISCOVERY
        ],
        details: {
          url: req.url,
          path: req.path
        }
      });

      // Resource is usually $baseUrl/mcp, but if PRM is at the root,
      // the resource identifier is the root.
      const resource =
        prmPath === '/.well-known/oauth-protected-resource'
          ? getBaseUrl()
          : `${getBaseUrl()}/mcp`;

      res.json({
        resource,
        authorization_servers: [getAuthServerUrl()]
      });
    });
  }

  app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    // Apply bearer token auth per-request in order to delay setting PRM URL
    // until after the server has started
    // TODO: Find a way to do this w/ pre-applying middleware.
    const authMiddleware = requireBearerAuth({
      verifier: new MockTokenVerifier(checks),
      requiredScopes: [],
      ...(prmPath !== null && {
        resourceMetadataUrl: `${getBaseUrl()}${prmPath}`
      })
    });

    authMiddleware(req, res, async (err?: any) => {
      if (err) return next(err);
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
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error'
            },
            id: null
          });
        }
      }
    });
  });

  return app;
}
