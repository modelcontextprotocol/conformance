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
import {
  validateStatelessRequest,
  withRequiredDraftResultFields,
  type ScenarioContext
} from '../../../../mock-server';
import { isStatefulVersion } from '../../../../connection/select';
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
   * Query string (without '?') that the MCP server URL carries and that the
   * client is expected to preserve when constructing the PRM well-known URL
   * (RFC 9728 §3.1 inserts the well-known suffix between the host and the
   * path and/or query components). When set, the PRM route emits the
   * `prm-query-preserved` check and includes the query in the `resource`
   * value. The metadata is served either way so the flow can continue.
   */
  expectedPrmQuery?: string;
}

export function createServer(
  ctx: ScenarioContext,
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
    expectedPrmQuery
  } = options;
  // Factory: create a fresh Server per request to avoid "Already connected" errors
  // after the v1.26.0 security fix (GHSA-345p-7cg4-v4c7)
  function createMcpServer() {
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
        tools: [
          {
            name: 'test-tool',
            inputSchema: { type: 'object' }
          }
        ]
      };
    });

    server.setRequestHandler(
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

    return server;
  }

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

      // RFC 9728 §3.1: for a resource identifier with a query component, the
      // well-known suffix is inserted between the host and the path and/or
      // query, so the query must survive into the PRM request. A stripped
      // query is recorded as a WARNING (the query-bearing identifier itself
      // is a SHOULD NOT-discouraged configuration per RFC 9728 §1.2), and the
      // metadata is served either way so the rest of the flow can proceed.
      if (expectedPrmQuery !== undefined) {
        const queryIndex = req.originalUrl.indexOf('?');
        const actualQuery =
          queryIndex >= 0 ? req.originalUrl.slice(queryIndex + 1) : '';
        const expectedParams = new URLSearchParams(expectedPrmQuery);
        const actualParams = new URLSearchParams(actualQuery);
        expectedParams.sort();
        actualParams.sort();
        const preserved = expectedParams.toString() === actualParams.toString();

        checks.push({
          id: 'prm-query-preserved',
          name: 'PRMQueryPreserved',
          description: preserved
            ? 'Client preserved the MCP server URL query component in the PRM well-known URL'
            : 'Client SHOULD preserve the MCP server URL query component when constructing the PRM well-known URL (RFC 9728 §3.1)',
          status: preserved ? 'SUCCESS' : 'WARNING',
          timestamp: new Date().toISOString(),
          specReferences: [
            SpecReferences.RFC_PRM_DISCOVERY,
            SpecReferences.MCP_PRM_DISCOVERY
          ],
          ...(preserved
            ? {}
            : {
                errorMessage: `Expected PRM request query "?${expectedPrmQuery}" but got "${actualQuery ? `?${actualQuery}` : '(no query)'}"`
              }),
          details: {
            url: req.originalUrl,
            expectedQuery: expectedPrmQuery,
            actualQuery
          }
        });
      }

      // Resource is usually $baseUrl/mcp, but if PRM is at the root,
      // the resource identifier is the root.
      // Can be overridden via prmResourceOverride for testing resource mismatch.
      const resource =
        prmResourceOverride ??
        (prmPath === '/.well-known/oauth-protected-resource'
          ? getBaseUrl()
          : `${getBaseUrl()}/mcp${expectedPrmQuery ? `?${expectedPrmQuery}` : ''}`);

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
      if (!isStatefulVersion(ctx.specVersion)) {
        return handleStateless(req, res);
      }
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      try {
        await server.connect(transport);
        // Register cleanup before handing the request to the transport so the
        // pair is torn down even when handleRequest throws.
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await transport.handleRequest(req, res, req.body);
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

  // Stateless lifecycle for the /mcp route: shared SEP-2575 validation +
  // server/discover from mock-server/stateless, then the same tools handlers
  // as createMcpServer. Bearer-auth middleware and PRM route above are
  // version-independent.
  function handleStateless(req: Request, res: Response) {
    const v = validateStatelessRequest(req, { tools: {} }, [ctx.specVersion]);
    if (v.kind !== 'route') {
      return res.status(v.status).json(v.body);
    }
    const { id, method } = v;
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: withRequiredDraftResultFields(method, {
          tools: [{ name: 'test-tool', inputSchema: { type: 'object' } }]
        })
      });
    }
    if (method === 'tools/call') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: withRequiredDraftResultFields(method, {
          content: [{ type: 'text', text: 'test' }]
        })
      });
    }
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' }
    });
  }

  return app;
}
