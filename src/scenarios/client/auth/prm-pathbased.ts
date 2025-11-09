import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Scenario, ConformanceCheck } from '../../../types.js';
import express, { Request, Response, NextFunction } from 'express';
import { ScenarioUrls } from '../../../types.js';

class MockTokenVerifier implements OAuthTokenVerifier {
  constructor(private checks: ConformanceCheck[]) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === 'test-token') {
      this.checks.push({
        id: 'valid-bearer-token',
        name: 'ValidBearerToken',
        description: 'Client provided valid bearer token',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Authorization',
            url: 'https://spec.modelcontextprotocol.io/specification/architecture/#authorization'
          }
        ],
        details: {
          token: token.substring(0, 10) + '...'
        }
      });
      return {
        token,
        clientId: 'test-client',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      };
    }

    this.checks.push({
      id: 'invalid-bearer-token',
      name: 'InvalidBearerToken',
      description: 'Client provided invalid bearer token',
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'MCP-Authorization',
          url: 'https://spec.modelcontextprotocol.io/specification/architecture/#authorization'
        }
      ],
      details: {
        message: 'Token verification failed',
        token: token ? token.substring(0, 10) + '...' : 'missing'
      }
    });
    throw new Error('Invalid token');
  }
}

function createServer(checks: ConformanceCheck[]): express.Application {
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

  app.use((req: Request, res: Response, next: NextFunction) => {
    checks.push({
      id: 'incoming-request',
      name: 'IncomingRequest',
      description: `Received ${req.method} request for ${req.url}`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        method: req.method,
        url: req.url,
        path: req.path
      }
    });
    next();
  });

  app.get(
    '/.well-known/oauth-protected-resource',
    (req: Request, res: Response) => {
      checks.push({
        id: 'prm-root-requested',
        name: 'PRMRootRequested',
        description: 'Client requested PRM metadata at root location',
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: {
          url: req.url,
          path: req.path
        }
      });

      res.json({
        resource: `http://localhost:${(req.socket.address() as any).port}`,
        authorization_servers: ['http://localhost:9999']
      });
    }
  );

  app.get(
    '/mcp/.well-known/oauth-protected-resource',
    (req: Request, res: Response) => {
      checks.push({
        id: 'prm-pathbased-requested',
        name: 'PRMPathBasedRequested',
        description: 'Client requested PRM metadata at path-based location',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'RFC-9728-3',
            url: 'https://tools.ietf.org/html/rfc9728#section-3'
          }
        ],
        details: {
          url: req.url,
          path: req.path
        }
      });

      res.json({
        resource: `http://localhost:${(req.socket.address() as any).port}`,
        authorization_servers: ['http://localhost:9999']
      });
    }
  );

  app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    const port = (req.socket.address() as any).port;
    const authMiddleware = requireBearerAuth({
      verifier: new MockTokenVerifier(checks),
      requiredScopes: [],
      resourceMetadataUrl: `http://localhost:${port}/mcp/.well-known/oauth-protected-resource`
    });

    authMiddleware(req, res, async (err?: any) => {
      if (err) return next(err);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
    });
  });

  return app;
}

export class PRMPathBasedScenario implements Scenario {
  name = 'auth-prm-pathbased';
  description =
    'Tests PRM discovery at path-based location (/mcp/.well-known/oauth-protected-resource)';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.app = createServer(this.checks);
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    return { serverUrl: `http://localhost:${port}/mcp` };
  }

  async stop() {
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'prm-pathbased-requested',
      'prm-root-not-checked-first'
    ];

    // const pathBasedCheck = this.checks.find((c) => c.id === 'prm-pathbased-requested');
    // const rootCheck = this.checks.find((c) => c.id === 'prm-root-requested');

    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name:
            slug === 'prm-pathbased-requested'
              ? 'PRMPathBasedRequested'
              : 'PRMRootNotCheckedFirst',
          description:
            slug === 'prm-pathbased-requested'
              ? 'Client should request PRM metadata at path-based location'
              : 'Client should check path-based location before root',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          details: { message: 'Expected check not found' },
          specReferences: [
            {
              id: 'RFC-9728-3',
              url: 'https://tools.ietf.org/html/rfc9728#section-3'
            }
          ]
        });
      }
    }

    return this.checks;
  }
}
