import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';

type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

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

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      tokenEndpointAuthMethodsSupported: [this.expectedAuthMethod],
      // Disable CIMD to force DCR - we need client_secret for auth method testing
      clientIdMetadataDocumentSupported: false,
      onTokenRequest: ({ authorizationHeader, body, timestamp }) => {
        const bodyClientSecret = body.client_secret;
        const actualMethod = detectAuthMethod(
          authorizationHeader,
          bodyClientSecret
        );
        const isCorrect = actualMethod === this.expectedAuthMethod;

        // For basic auth, also validate the format
        let formatError: string | undefined;
        if (actualMethod === 'client_secret_basic' && authorizationHeader) {
          const validation = validateBasicAuthFormat(authorizationHeader);
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
          timestamp,
          specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
          details: {
            expectedAuthMethod: this.expectedAuthMethod,
            actualAuthMethod: actualMethod,
            hasAuthorizationHeader: !!authorizationHeader,
            hasBodyClientSecret: !!bodyClientSecret,
            ...(formatError && { formatError })
          }
        });

        return {
          token: `test-token-${Date.now()}`,
          scopes: []
        };
      },
      onRegistrationRequest: () => ({
        clientId: `test-client-${Date.now()}`,
        clientSecret:
          this.expectedAuthMethod === 'none'
            ? undefined
            : `test-secret-${Date.now()}`,
        tokenEndpointAuthMethod: this.expectedAuthMethod
      })
    });
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
