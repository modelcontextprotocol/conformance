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

function createAuthServer(
  checks: ConformanceCheck[],
  getAuthBaseUrl: () => string
): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    checks.push({
      id: 'incoming-auth-request',
      name: 'IncomingAuthRequest',
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
    '/.well-known/oauth-authorization-server',
    (req: Request, res: Response) => {
      checks.push({
        id: 'authorization-server-metadata',
        name: 'AuthorizationServerMetadata',
        description: 'Client requested authorization server metadata',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'RFC-8414',
            url: 'https://tools.ietf.org/html/rfc8414'
          }
        ],
        details: {
          url: req.url,
          path: req.path
        }
      });

      res.json({
        issuer: getAuthBaseUrl(),
        authorization_endpoint: `${getAuthBaseUrl()}/authorize`,
        token_endpoint: `${getAuthBaseUrl()}/token`,
        registration_endpoint: `${getAuthBaseUrl()}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
  );

  app.get('/authorize', (req: Request, res: Response) => {
    checks.push({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'RFC-6749-4.1.1',
          url: 'https://tools.ietf.org/html/rfc6749#section-4.1.1'
        }
      ],
      details: {
        response_type: req.query.response_type,
        client_id: req.query.client_id,
        redirect_uri: req.query.redirect_uri,
        state: req.query.state,
        code_challenge: req.query.code_challenge ? 'present' : 'missing',
        code_challenge_method: req.query.code_challenge_method
      }
    });

    const redirectUri = req.query.redirect_uri as string;
    const state = req.query.state as string;
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', 'test-auth-code');
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    res.redirect(redirectUrl.toString());
  });

  app.post('/token', (req: Request, res: Response) => {
    res.json({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600
    });
  });

  app.post('/register', (req: Request, res: Response) => {
    res.status(201).json({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      client_name: req.body.client_name || 'test-client',
      redirect_uris: req.body.redirect_uris || []
    });
  });

  return app;
}

function createServer(
  checks: ConformanceCheck[],
  getBaseUrl: () => string,
  getAuthServerUrl: () => string
): express.Application {
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
    let description = `Received ${req.method} request for ${req.url}`;
    const details: any = {
      method: req.method,
      url: req.url,
      path: req.path
    };

    // Extract MCP method if this is the /mcp endpoint
    if (
      req.path === '/mcp' &&
      req.body &&
      typeof req.body === 'object' &&
      req.body.method
    ) {
      const mcpMethod = req.body.method;
      description += ` (method: ${mcpMethod})`;
      details.mcpMethod = mcpMethod;
    }

    checks.push({
      id: 'incoming-request',
      name: 'IncomingRequest',
      description: description,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: details
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
        resource: getBaseUrl(),
        authorization_servers: [getAuthServerUrl()]
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
        resource: getBaseUrl(),
        authorization_servers: [getAuthServerUrl()]
      });
    }
  );

  app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    // Apply bearer token auth per-request in order to delay setting PRM URL
    // until after the server has started
    // TODO: Find a way to do this w/ pre-applying middleware.
    const authMiddleware = requireBearerAuth({
      verifier: new MockTokenVerifier(checks),
      requiredScopes: [],
      resourceMetadataUrl: `${getBaseUrl()}/mcp/.well-known/oauth-protected-resource`
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

export class PRMPathBasedScenario implements Scenario {
  name = 'auth-prm-pathbased';
  description =
    'Tests PRM discovery at path-based location (/mcp/.well-known/oauth-protected-resource)';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private authApp: express.Application | null = null;
  private authHttpServer: any = null;
  private checks: ConformanceCheck[] = [];
  private baseUrl: string = '';
  private authBaseUrl: string = '';

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    this.authApp = createAuthServer(this.checks, () => this.authBaseUrl);
    this.authHttpServer = this.authApp.listen(0);
    const authPort = this.authHttpServer.address().port;
    this.authBaseUrl = `http://localhost:${authPort}`;

    this.app = createServer(
      this.checks,
      () => this.baseUrl,
      () => this.authBaseUrl
    );
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    this.baseUrl = `http://localhost:${port}`;

    return { serverUrl: `${this.baseUrl}/mcp` };
  }

  async stop() {
    if (this.authHttpServer) {
      await new Promise<void>((resolve) => {
        this.authHttpServer.closeAllConnections?.();
        this.authHttpServer.close(() => resolve());
      });
      this.authHttpServer = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.closeAllConnections?.();
        this.httpServer.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.authApp = null;
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'prm-pathbased-requested',
      // 'prm-root-not-checked-first'
      'authorization-server-metadata',
      'authorization-request'
    ];

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
