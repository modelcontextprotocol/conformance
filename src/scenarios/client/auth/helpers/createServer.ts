import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express, { Request, Response, NextFunction } from 'express';
import type { ConformanceCheck } from '../../../../types';
import { createRequestLogger } from '../../../request-logger';
import { MockTokenVerifier } from './mockTokenVerifier';
import { SpecReferences } from '../spec-references';

export interface ServerOptions {
  prmPath?: string | null;
  requiredScopes?: string[];
  scopesSupported?: string[];
  includePrmInWwwAuth?: boolean;
  includeScopeInWwwAuth?: boolean;
  authMiddleware?: express.RequestHandler;
  tokenVerifier?: MockTokenVerifier;
  /** Override the resource field in PRM response (for testing resource mismatch) */
  prmResourceOverride?: string;
  /**
   * When true, create a fresh MCP Server for each request instead of
   * reusing one.  Required for token refresh tests where requests span
   * token expiry boundaries (the default behaviour calls server.close()
   * on response end, which breaks subsequent requests).
   */
  perRequestServer?: boolean;
}

export function createServer(
  checks: ConformanceCheck[],
  getBaseUrl: () => string,
  getAuthServerUrl: () => string,
  options: ServerOptions = {}
): express.Application {
  const {
    prmPath = '/.well-known/oauth-protected-resource/mcp',
    requiredScopes = [],
    scopesSupported,
    includePrmInWwwAuth = true,
    includeScopeInWwwAuth = false,
    tokenVerifier,
    prmResourceOverride,
    perRequestServer = false,
  } = options;

  function createMcpServer(): Server {
    const srv = new Server(
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

    srv.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'test-tool',
            inputSchema: { type: 'object' }
          }
        ]
      };
    });

    srv.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        if (request.params.name === 'test-tool') {
          return {
            content: [{ type: 'text', text: 'test' }]
          };
        }
        throw new McpError(
          ErrorCode.InvalidParams,
          `Tool ${request.params.name} not found`
        );
      }
    );

    return srv;
  }

  // For the default (non-per-request) mode, reuse a single server instance.
  const server = perRequestServer ? null : createMcpServer();

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
      // Can be overridden via prmResourceOverride for testing resource mismatch.
      const resource =
        prmResourceOverride ??
        (prmPath === '/.well-known/oauth-protected-resource'
          ? getBaseUrl()
          : `${getBaseUrl()}/mcp`);

      const prmResponse: any = {
        resource,
        authorization_servers: [getAuthServerUrl()]
      };

      if (scopesSupported !== undefined) {
        prmResponse.scopes_supported = scopesSupported;
      }

      res.json(prmResponse);
    });
  }

  app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    // Apply bearer token auth per-request in order to delay setting PRM URL
    // until after the server has started
    // TODO: Find a way to do this w/ pre-applying middleware.
    const verifier =
      tokenVerifier || new MockTokenVerifier(checks, requiredScopes);

    const authMiddleware =
      options.authMiddleware ??
      requireBearerAuth({
        verifier,
        // Only pass requiredScopes if we want them in the WWW-Authenticate header
        requiredScopes: includeScopeInWwwAuth ? requiredScopes : [],
        ...(includePrmInWwwAuth &&
          prmPath !== null && {
            resourceMetadataUrl: `${getBaseUrl()}${prmPath}`
          })
      });

    authMiddleware(req, res, async (err?: any) => {
      if (err) return next(err);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      // In per-request mode, create a fresh MCP server for each request
      // so that server.close() doesn't break subsequent requests across
      // token expiry boundaries.
      const srv = perRequestServer ? createMcpServer() : server!;

      try {
        await srv.connect(transport);

        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          transport.close();
          srv.close();
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
