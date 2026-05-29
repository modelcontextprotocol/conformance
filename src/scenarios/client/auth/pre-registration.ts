import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { SpecReferences } from './spec-references';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';

const PRE_REGISTERED_CLIENT_ID = 'pre-registered-client';
const PRE_REGISTERED_CLIENT_SECRET = 'pre-registered-secret';

/**
 * Scenario: Pre-registration (static client credentials)
 *
 * Tests OAuth flow where the server does NOT support Dynamic Client Registration.
 * Clients must use pre-registered credentials passed via context.
 *
 * This tests the pre-registration approach described in the MCP spec:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization#preregistration
 */
export class PreRegistrationScenario extends AuthHandlerScenario {
  name = 'auth/pre-registration';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests OAuth flow with pre-registered client credentials. Server does not support DCR.';

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, getAsUrl, {
      tokenVerifier,
      disableDynamicRegistration: true,
      tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
      onTokenRequest: ({ authorizationHeader, timestamp }) => {
        // Verify client used pre-registered credentials via Basic auth
        if (!authorizationHeader?.startsWith('Basic ')) {
          this.checks.push({
            id: 'pre-registration-auth',
            name: 'Pre-registration authentication',
            description:
              'Client did not use Basic authentication with pre-registered credentials',
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.MCP_PREREGISTRATION]
          });
          return {
            error: 'invalid_client',
            errorDescription: 'Missing or invalid Authorization header',
            statusCode: 401
          };
        }

        const base64Credentials = authorizationHeader.slice(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString(
          'utf-8'
        );
        const [clientId, clientSecret] = credentials.split(':');

        if (
          clientId !== PRE_REGISTERED_CLIENT_ID ||
          clientSecret !== PRE_REGISTERED_CLIENT_SECRET
        ) {
          this.checks.push({
            id: 'pre-registration-auth',
            name: 'Pre-registration authentication',
            description: `Client used incorrect pre-registered credentials. Expected client_id '${PRE_REGISTERED_CLIENT_ID}', got '${clientId}'`,
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.MCP_PREREGISTRATION],
            details: {
              expectedClientId: PRE_REGISTERED_CLIENT_ID,
              actualClientId: clientId
            }
          });
          return {
            error: 'invalid_client',
            errorDescription: 'Invalid pre-registered credentials',
            statusCode: 401
          };
        }

        // Success - client used correct pre-registered credentials
        this.checks.push({
          id: 'pre-registration-auth',
          name: 'Pre-registration authentication',
          description:
            'Client correctly used pre-registered credentials when server does not support DCR',
          status: 'SUCCESS',
          timestamp,
          specReferences: [SpecReferences.MCP_PREREGISTRATION],
          details: { clientId }
        });

        return {
          token: `test-token-prereg-${Date.now()}`,
          scopes: []
        };
      }
    });

    const rsApp = createServer(this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  protected scenarioContext() {
    return {
      client_id: PRE_REGISTERED_CLIENT_ID,
      client_secret: PRE_REGISTERED_CLIENT_SECRET
    };
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the pre-registration check
    const hasPreRegCheck = this.checks.some(
      (c) => c.id === 'pre-registration-auth'
    );
    if (!hasPreRegCheck) {
      this.checks.push({
        id: 'pre-registration-auth',
        name: 'Pre-registration authentication',
        description: 'Client did not make a token request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_PREREGISTRATION]
      });
    }

    return this.checks;
  }
}
