import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import { createRequestLogger } from '../../request-logger.js';
import express, { Request, Response } from 'express';

type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

interface AuthServerOptions {
  tokenVerifier?: MockTokenVerifier;
  tokenEndpointAuthMethodsSupported: string[];
  expectedAuthMethod: AuthMethod;
  onTokenRequest?: (requestData: {
    authorizationHeader?: string;
    bodyClientSecret?: string;
    timestamp: string;
  }) => void;
}

function detectAuthMethod(
  authorizationHeader?: string,
  bodyClientSecret?: string
): AuthMethod {
  if (authorizationHeader?.startsWith('Basic ')) {
    return 'client_secret_basic';
  }
  if (bodyClientSecret) {
    return 'client_secret_post';
  }
  return 'none';
}

function validateBasicAuthFormat(authorizationHeader: string): {
  valid: boolean;
  error?: string;
} {
  const encoded = authorizationHeader.substring('Basic '.length);
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    if (!decoded.includes(':')) {
      return { valid: false, error: 'missing colon separator' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'base64 decoding failed' };
  }
}

function createAuthServerForTokenAuth(
  checks: ConformanceCheck[],
  getAuthBaseUrl: () => string,
  options: AuthServerOptions
): express.Application {
  const {
    tokenVerifier,
    tokenEndpointAuthMethodsSupported,
    expectedAuthMethod,
    onTokenRequest
  } = options;

  const authRoutes = {
    authorization_endpoint: '/authorize',
    token_endpoint: '/token',
    registration_endpoint: '/register'
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    createRequestLogger(checks, {
      incomingId: 'incoming-auth-request',
      outgoingId: 'outgoing-auth-response'
    })
  );

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
          SpecReferences.RFC_AUTH_SERVER_METADATA_REQUEST,
          SpecReferences.MCP_AUTH_DISCOVERY
        ],
        details: {
          url: req.url,
          path: req.path
        }
      });

      res.json({
        issuer: getAuthBaseUrl(),
        authorization_endpoint: `${getAuthBaseUrl()}${authRoutes.authorization_endpoint}`,
        token_endpoint: `${getAuthBaseUrl()}${authRoutes.token_endpoint}`,
        registration_endpoint: `${getAuthBaseUrl()}${authRoutes.registration_endpoint}`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: tokenEndpointAuthMethodsSupported
      });
    }
  );

  app.get(authRoutes.authorization_endpoint, (req: Request, res: Response) => {
    checks.push({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_ENDPOINT],
      details: { query: req.query }
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

  app.post(authRoutes.token_endpoint, (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const authorizationHeader = req.headers.authorization as string | undefined;
    const bodyClientSecret = req.body.client_secret;

    checks.push({
      id: 'token-request',
      name: 'TokenRequest',
      description: 'Client requested access token',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
      details: {
        endpoint: '/token',
        grantType: req.body.grant_type,
        hasAuthorizationHeader: !!authorizationHeader,
        hasBodyClientSecret: !!bodyClientSecret
      }
    });

    if (onTokenRequest) {
      onTokenRequest({ authorizationHeader, bodyClientSecret, timestamp });
    }

    const token = `test-token-${Date.now()}`;
    if (tokenVerifier) {
      tokenVerifier.registerToken(token, []);
    }

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600
    });
  });

  app.post(authRoutes.registration_endpoint, (req: Request, res: Response) => {
    const clientId = `test-client-${Date.now()}`;
    const clientSecret =
      expectedAuthMethod === 'none' ? undefined : `test-secret-${Date.now()}`;

    checks.push({
      id: 'client-registration',
      name: 'ClientRegistration',
      description: 'Client registered with authorization server',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.MCP_DCR],
      details: {
        endpoint: '/register',
        clientName: req.body.client_name,
        tokenEndpointAuthMethod: expectedAuthMethod
      }
    });

    res.status(201).json({
      client_id: clientId,
      ...(clientSecret && { client_secret: clientSecret }),
      client_name: req.body.client_name || 'test-client',
      redirect_uris: req.body.redirect_uris || [],
      token_endpoint_auth_method: expectedAuthMethod
    });
  });

  return app;
}

const AUTH_METHOD_NAMES: Record<AuthMethod, string> = {
  client_secret_basic: 'HTTP Basic authentication (client_secret_basic)',
  client_secret_post: 'client_secret_post',
  none: 'no authentication (public client)'
};

class TokenEndpointAuthScenario implements Scenario {
  name: string;
  description: string;
  private expectedAuthMethod: AuthMethod;
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  constructor(expectedAuthMethod: AuthMethod) {
    this.expectedAuthMethod = expectedAuthMethod;
    this.name = `auth/token-endpoint-auth-${expectedAuthMethod === 'client_secret_basic' ? 'basic' : expectedAuthMethod === 'client_secret_post' ? 'post' : 'none'}`;
    this.description = `Tests that client uses ${AUTH_METHOD_NAMES[expectedAuthMethod]} when server only supports ${expectedAuthMethod}`;
  }

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServerForTokenAuth(
      this.checks,
      this.authServer.getUrl,
      {
        tokenVerifier,
        tokenEndpointAuthMethodsSupported: [this.expectedAuthMethod],
        expectedAuthMethod: this.expectedAuthMethod,
        onTokenRequest: (data) => {
          const actualMethod = detectAuthMethod(
            data.authorizationHeader,
            data.bodyClientSecret
          );
          const isCorrect = actualMethod === this.expectedAuthMethod;

          // For basic auth, also validate the format
          let formatError: string | undefined;
          if (
            actualMethod === 'client_secret_basic' &&
            data.authorizationHeader
          ) {
            const validation = validateBasicAuthFormat(
              data.authorizationHeader
            );
            if (!validation.valid) {
              formatError = validation.error;
            }
          }

          const status = isCorrect && !formatError ? 'SUCCESS' : 'FAILURE';
          let description: string;

          if (formatError) {
            description = `Client sent Basic auth header but ${formatError}`;
          } else if (isCorrect) {
            description = `Client correctly used ${AUTH_METHOD_NAMES[this.expectedAuthMethod]} for token endpoint`;
          } else {
            description = `Client used ${actualMethod} but server only supports ${this.expectedAuthMethod}`;
          }

          this.checks.push({
            id: 'token-endpoint-auth-method',
            name: 'Token endpoint authentication method',
            description,
            status,
            timestamp: data.timestamp,
            specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
            details: {
              expectedAuthMethod: this.expectedAuthMethod,
              actualAuthMethod: actualMethod,
              hasAuthorizationHeader: !!data.authorizationHeader,
              hasBodyClientSecret: !!data.bodyClientSecret,
              ...(formatError && { formatError })
            }
          });
        }
      }
    );
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [],
        tokenVerifier
      }
    );
    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    if (!this.checks.some((c) => c.id === 'token-endpoint-auth-method')) {
      this.checks.push({
        id: 'token-endpoint-auth-method',
        name: 'Token endpoint authentication method',
        description: 'Client did not make a token request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN]
      });
    }
    return this.checks;
  }
}

export class ClientSecretBasicAuthScenario extends TokenEndpointAuthScenario {
  constructor() {
    super('client_secret_basic');
  }
}

export class ClientSecretPostAuthScenario extends TokenEndpointAuthScenario {
  constructor() {
    super('client_secret_post');
  }
}

export class PublicClientAuthScenario extends TokenEndpointAuthScenario {
  constructor() {
    super('none');
  }
}
