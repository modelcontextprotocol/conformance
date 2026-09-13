import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck
} from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import {
  addResourceParameterChecks,
  observeResourceParameters
} from './helpers/resourceParameterChecks.js';

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

class TokenEndpointAuthScenario extends AuthHandlerScenario {
  name: string;
  readonly source = { introducedIn: '2025-06-18' } as const;
  description: string;
  private expectedAuthMethod: AuthMethod;
  private checks: ConformanceCheck[] = [];

  // Track resource parameters for RFC 8707 validation
  private authorizationResource?: string;
  private tokenResource?: string;
  private prmResource?: string;

  constructor(expectedAuthMethod: AuthMethod) {
    super();
    this.expectedAuthMethod = expectedAuthMethod;
    this.name = `auth/token-endpoint-auth-${expectedAuthMethod === 'client_secret_basic' ? 'basic' : expectedAuthMethod === 'client_secret_post' ? 'post' : 'none'}`;
    this.description = `Tests that client uses ${AUTH_METHOD_NAMES[expectedAuthMethod]} when server only supports ${expectedAuthMethod}`;
  }

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    this.authorizationResource = undefined;
    this.tokenResource = undefined;
    this.prmResource = undefined;
    const getAsUrl = () => ctx.getAuxBaseUrl('as');
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      tokenEndpointAuthMethodsSupported: [this.expectedAuthMethod],
      onAuthorizationRequest: ({ resource }) => {
        this.authorizationResource = resource;
      },
      onTokenRequest: ({ authorizationHeader, body, timestamp }) => {
        // Track resource from token request for RFC 8707 validation
        this.tokenResource = body.resource;
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

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [],
      tokenVerifier,
      onPrmRequest: ({ resource }) => {
        this.prmResource = resource;
      }
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (!checks.some((c) => c.id === 'token-endpoint-auth-method')) {
      checks.push({
        id: 'token-endpoint-auth-method',
        name: 'Token endpoint authentication method',
        description: 'Client did not make a token request',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN]
      });
    }

    // RFC 8707 Resource Parameter Validation Checks. The private fields are
    // empty when a fresh instance re-judges a persisted log (hosted server),
    // so fall back to what the request logger recorded.
    const observed = observeResourceParameters(this.checks);
    addResourceParameterChecks(
      checks,
      {
        authorizationResource:
          this.authorizationResource ?? observed.authorizationResource,
        tokenResource: this.tokenResource ?? observed.tokenResource,
        prmResource: this.prmResource ?? observed.prmResource
      },
      timestamp
    );

    return checks;
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
