import * as jose from 'jose';
import type { CryptoKey } from 'jose';
import type { Scenario, ConformanceCheck, ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';

const CONFORMANCE_TEST_CLIENT_ID = 'conformance-test-client';
const CONFORMANCE_TEST_CLIENT_SECRET = 'conformance-test-secret';

/**
 * Generate an EC P-256 keypair for JWT signing.
 * Returns both public key (for server verification) and private key PEM (for client signing).
 */
async function generateTestKeypair(): Promise<{
  publicKey: CryptoKey;
  privateKeyPem: string;
}> {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', {
    extractable: true
  });
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  return { publicKey, privateKeyPem };
}

/**
 * Scenario: Client Credentials with JWT Authentication (SEP-1046)
 *
 * Tests OAuth client_credentials flow with private_key_jwt authentication.
 * Client authenticates using a JWT assertion signed with a dynamically generated keypair.
 */
export class ClientCredentialsJwtScenario implements Scenario {
  name = 'auth/client-credentials-jwt';
  description =
    'Tests OAuth client_credentials flow with private_key_jwt authentication (SEP-1046)';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    // Generate a fresh keypair for this test run
    const { publicKey, privateKeyPem } = await generateTestKeypair();

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: ['client_credentials'],
      tokenEndpointAuthMethodsSupported: ['private_key_jwt'],
      tokenEndpointAuthSigningAlgValuesSupported: ['ES256'],
      onTokenRequest: async ({ grantType, body, timestamp, authBaseUrl }) => {
        // Per RFC 7523bis, the audience MUST be the issuer identifier
        // The SDK uses metadata.issuer as audience, which matches authBaseUrl
        const issuerUrl = authBaseUrl;
        if (grantType !== 'client_credentials') {
          this.checks.push({
            id: 'client-credentials-grant-type',
            name: 'ClientCredentialsGrantType',
            description: `Expected grant_type=client_credentials, got ${grantType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
              SpecReferences.SEP_1046_CLIENT_CREDENTIALS
            ]
          });
          return {
            error: 'unsupported_grant_type',
            errorDescription: 'Only client_credentials grant is supported'
          };
        }

        const clientAssertion = body.client_assertion;
        const clientAssertionType = body.client_assertion_type;

        // Verify assertion type
        if (
          clientAssertionType !==
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        ) {
          this.checks.push({
            id: 'client-credentials-assertion-type',
            name: 'ClientCredentialsAssertionType',
            description: `Invalid client_assertion_type: ${clientAssertionType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_JWT_CLIENT_AUTH]
          });
          return {
            error: 'invalid_client',
            errorDescription: 'Invalid client_assertion_type',
            statusCode: 401
          };
        }

        // Verify JWT signature and claims using the generated public key
        try {
          // Per RFC 7523bis, audience MUST be the issuer identifier
          const { payload } = await jose.jwtVerify(clientAssertion, publicKey, {
            audience: issuerUrl,
            clockTolerance: 30
          });

          // Verify iss claim matches expected client_id
          if (payload.iss !== CONFORMANCE_TEST_CLIENT_ID) {
            this.checks.push({
              id: 'client-credentials-jwt-iss',
              name: 'ClientCredentialsJwtIss',
              description: `JWT iss claim '${payload.iss}' does not match expected client_id '${CONFORMANCE_TEST_CLIENT_ID}'`,
              status: 'FAILURE',
              timestamp,
              specReferences: [SpecReferences.RFC_JWT_CLIENT_AUTH],
              details: {
                expected: CONFORMANCE_TEST_CLIENT_ID,
                actual: payload.iss
              }
            });
            return {
              error: 'invalid_client',
              errorDescription:
                'JWT iss claim does not match expected client_id',
              statusCode: 401
            };
          }

          // Verify sub claim matches expected client_id
          if (payload.sub !== CONFORMANCE_TEST_CLIENT_ID) {
            this.checks.push({
              id: 'client-credentials-jwt-sub',
              name: 'ClientCredentialsJwtSub',
              description: `JWT sub claim '${payload.sub}' does not match expected client_id '${CONFORMANCE_TEST_CLIENT_ID}'`,
              status: 'FAILURE',
              timestamp,
              specReferences: [SpecReferences.RFC_JWT_CLIENT_AUTH],
              details: {
                expected: CONFORMANCE_TEST_CLIENT_ID,
                actual: payload.sub
              }
            });
            return {
              error: 'invalid_client',
              errorDescription:
                'JWT sub claim does not match expected client_id',
              statusCode: 401
            };
          }

          // Success!
          this.checks.push({
            id: 'client-credentials-jwt-verified',
            name: 'ClientCredentialsJwtVerified',
            description:
              'Client successfully authenticated with signed JWT assertion',
            status: 'SUCCESS',
            timestamp,
            specReferences: [
              SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
              SpecReferences.SEP_1046_CLIENT_CREDENTIALS,
              SpecReferences.RFC_JWT_CLIENT_AUTH
            ],
            details: {
              iss: payload.iss,
              sub: payload.sub,
              aud: payload.aud
            }
          });

          const scopes = body.scope ? body.scope.split(' ') : [];
          return {
            token: `cc-token-${Date.now()}`,
            scopes
          };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          this.checks.push({
            id: 'client-credentials-jwt-verified',
            name: 'ClientCredentialsJwtVerified',
            description: `JWT verification failed: ${errorMessage}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_JWT_CLIENT_AUTH],
            details: { error: errorMessage }
          });
          return {
            error: 'invalid_client',
            errorDescription: `JWT verification failed: ${errorMessage}`,
            statusCode: 401
          };
        }
      }
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl
    );

    await this.server.start(app);

    return {
      serverUrl: `${this.server.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        private_key_pem: privateKeyPem,
        signing_algorithm: 'ES256'
      }
    };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the JWT verification check
    const hasJwtCheck = this.checks.some(
      (c) => c.id === 'client-credentials-jwt-verified'
    );
    if (!hasJwtCheck) {
      this.checks.push({
        id: 'client-credentials-jwt-verified',
        name: 'ClientCredentialsJwtVerified',
        description: 'Client did not make a client_credentials token request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
          SpecReferences.SEP_1046_CLIENT_CREDENTIALS
        ]
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: Client Credentials with client_secret_basic Authentication
 *
 * Tests OAuth client_credentials flow with HTTP Basic authentication.
 */
export class ClientCredentialsBasicScenario implements Scenario {
  name = 'auth/client-credentials-basic';
  description =
    'Tests OAuth client_credentials flow with client_secret_basic authentication';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: ['client_credentials'],
      tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
      onTokenRequest: async ({
        grantType,
        body,
        timestamp,
        authorizationHeader
      }) => {
        if (grantType !== 'client_credentials') {
          this.checks.push({
            id: 'client-credentials-grant-type',
            name: 'ClientCredentialsGrantType',
            description: `Expected grant_type=client_credentials, got ${grantType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
              SpecReferences.SEP_1046_CLIENT_CREDENTIALS
            ]
          });
          return {
            error: 'unsupported_grant_type',
            errorDescription: 'Only client_credentials grant is supported'
          };
        }

        // Verify Basic auth header
        const authHeader = authorizationHeader;
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          this.checks.push({
            id: 'client-credentials-basic-auth',
            name: 'ClientCredentialsBasicAuth',
            description:
              'Missing or invalid Authorization header for Basic auth',
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.SEP_1046_CLIENT_CREDENTIALS]
          });
          return {
            error: 'invalid_client',
            errorDescription: 'Missing or invalid Authorization header',
            statusCode: 401
          };
        }

        const base64Credentials = authHeader.slice(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString(
          'utf-8'
        );
        const [clientId, clientSecret] = credentials.split(':');

        if (
          clientId !== CONFORMANCE_TEST_CLIENT_ID ||
          clientSecret !== CONFORMANCE_TEST_CLIENT_SECRET
        ) {
          this.checks.push({
            id: 'client-credentials-basic-auth',
            name: 'ClientCredentialsBasicAuth',
            description: 'Invalid client credentials',
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.SEP_1046_CLIENT_CREDENTIALS],
            details: { clientId }
          });
          return {
            error: 'invalid_client',
            errorDescription: 'Invalid client credentials',
            statusCode: 401
          };
        }

        // Success!
        this.checks.push({
          id: 'client-credentials-basic-auth',
          name: 'ClientCredentialsBasicAuth',
          description:
            'Client successfully authenticated with client_secret_basic',
          status: 'SUCCESS',
          timestamp,
          specReferences: [
            SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
            SpecReferences.SEP_1046_CLIENT_CREDENTIALS
          ],
          details: { clientId }
        });

        const scopes = body.scope ? body.scope.split(' ') : [];
        return {
          token: `cc-token-${Date.now()}`,
          scopes
        };
      }
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl
    );

    await this.server.start(app);

    return {
      serverUrl: `${this.server.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        client_secret: CONFORMANCE_TEST_CLIENT_SECRET
      }
    };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the basic auth check
    const hasBasicAuthCheck = this.checks.some(
      (c) => c.id === 'client-credentials-basic-auth'
    );
    if (!hasBasicAuthCheck) {
      this.checks.push({
        id: 'client-credentials-basic-auth',
        name: 'ClientCredentialsBasicAuth',
        description: 'Client did not make a client_credentials token request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
          SpecReferences.SEP_1046_CLIENT_CREDENTIALS
        ]
      });
    }

    return this.checks;
  }
}
