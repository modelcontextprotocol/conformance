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

  // Track resource parameters for RFC 8707 validation
  private authorizationResource?: string;
  private tokenResource?: string;

  constructor(expectedAuthMethod: AuthMethod) {
    this.expectedAuthMethod = expectedAuthMethod;
    this.name = `auth/token-endpoint-auth-${expectedAuthMethod === 'client_secret_basic' ? 'basic' : expectedAuthMethod === 'client_secret_post' ? 'post' : 'none'}`;
    this.description = `Tests that client uses ${AUTH_METHOD_NAMES[expectedAuthMethod]} when server only supports ${expectedAuthMethod}`;
  }

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationResource = undefined;
    this.tokenResource = undefined;
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
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
    const timestamp = new Date().toISOString();

    if (!this.checks.some((c) => c.id === 'token-endpoint-auth-method')) {
      this.checks.push({
        id: 'token-endpoint-auth-method',
        name: 'Token endpoint authentication method',
        description: 'Client did not make a token request',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN]
      });
    }

    // RFC 8707 Resource Parameter Validation Checks
    this.addResourceParameterChecks(timestamp);

    return this.checks;
  }

  private addResourceParameterChecks(timestamp: string): void {
    const specRefs = [
      SpecReferences.RFC_8707_RESOURCE_INDICATORS,
      SpecReferences.MCP_RESOURCE_PARAMETER
    ];

    // Check 1: Resource parameter in authorization request
    if (
      !this.checks.some((c) => c.id === 'resource-parameter-in-authorization')
    ) {
      const hasResource = !!this.authorizationResource;
      this.checks.push({
        id: 'resource-parameter-in-authorization',
        name: 'Resource parameter in authorization request',
        description: hasResource
          ? 'Client included resource parameter in authorization request'
          : 'Client MUST include resource parameter in authorization request per RFC 8707',
        status: hasResource ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          resource: this.authorizationResource || 'not provided'
        }
      });
    }

    // Check 2: Resource parameter in token request
    if (!this.checks.some((c) => c.id === 'resource-parameter-in-token')) {
      const hasResource = !!this.tokenResource;
      this.checks.push({
        id: 'resource-parameter-in-token',
        name: 'Resource parameter in token request',
        description: hasResource
          ? 'Client included resource parameter in token request'
          : 'Client MUST include resource parameter in token request per RFC 8707',
        status: hasResource ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          resource: this.tokenResource || 'not provided'
        }
      });
    }

    // Check 3: Resource parameter is valid canonical URI
    if (!this.checks.some((c) => c.id === 'resource-parameter-valid-uri')) {
      const resourceToValidate =
        this.authorizationResource || this.tokenResource;
      if (resourceToValidate) {
        const validation = this.validateCanonicalUri(resourceToValidate);
        this.checks.push({
          id: 'resource-parameter-valid-uri',
          name: 'Resource parameter is valid canonical URI',
          description: validation.valid
            ? 'Resource parameter is a valid canonical URI (has scheme, no fragment)'
            : `Resource parameter is invalid: ${validation.error}`,
          status: validation.valid ? 'SUCCESS' : 'FAILURE',
          timestamp,
          specReferences: specRefs,
          details: {
            resource: resourceToValidate,
            ...(validation.error && { error: validation.error })
          }
        });
      }
    }

    // Check 4: Resource parameter consistency between requests
    if (!this.checks.some((c) => c.id === 'resource-parameter-consistency')) {
      if (this.authorizationResource && this.tokenResource) {
        const consistent = this.authorizationResource === this.tokenResource;
        this.checks.push({
          id: 'resource-parameter-consistency',
          name: 'Resource parameter consistency',
          description: consistent
            ? 'Resource parameter is consistent between authorization and token requests'
            : 'Resource parameter MUST be consistent between authorization and token requests',
          status: consistent ? 'SUCCESS' : 'FAILURE',
          timestamp,
          specReferences: specRefs,
          details: {
            authorizationResource: this.authorizationResource,
            tokenResource: this.tokenResource
          }
        });
      }
    }
  }

  private validateCanonicalUri(uri: string): {
    valid: boolean;
    error?: string;
  } {
    try {
      const parsed = new URL(uri);
      // Check for fragment (RFC 8707: MUST NOT include fragment)
      if (parsed.hash) {
        return {
          valid: false,
          error: 'contains fragment (not allowed per RFC 8707)'
        };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'invalid URI format' };
    }
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
