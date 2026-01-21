import * as jose from 'jose';
import type { CryptoKey } from 'jose';
import express, { type Request, type Response } from 'express';
import type { Scenario, ConformanceCheck, ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';

const CONFORMANCE_TEST_CLIENT_ID = 'conformance-test-xaa-client';
const DEMO_USER_ID = 'demo-user@example.com';

/**
 * Generate an EC P-256 keypair for IDP ID token signing.
 */
async function generateIdpKeypair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}> {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', {
    extractable: true
  });
  return { publicKey, privateKey };
}

/**
 * Create a signed ID token from the IDP
 */
async function createIdpIdToken(
  privateKey: CryptoKey,
  idpIssuer: string,
  audience: string,
  userId: string = DEMO_USER_ID
): Promise<string> {
  return await new jose.SignJWT({
    sub: userId,
    email: userId,
    aud: audience
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(idpIssuer)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

/**
 * Scenario: Token Exchange Flow (RFC 8693)
 *
 * Tests that the client can exchange an IDP ID token for an authorization grant
 * using RFC 8693 token exchange, and then exchange that grant for an access token
 * using RFC 7523 JWT Bearer grant.
 */
export class CrossAppAccessTokenExchangeScenario implements Scenario {
  name = 'auth/cross-app-access-token-exchange';
  description =
    'Tests RFC 8693 token exchange flow for converting IDP ID token to authorization grant (SEP-990)';

  private idpServer = new ServerLifecycle();
  private authServer = new ServerLifecycle();
  private mcpServer = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private idpPublicKey?: CryptoKey;
  private idpPrivateKey?: CryptoKey;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    // Generate IDP keypair for signing ID tokens
    const { publicKey, privateKey } = await generateIdpKeypair();
    this.idpPublicKey = publicKey;
    this.idpPrivateKey = privateKey;

    // Start IDP server (simulates enterprise identity provider)
    await this.startIdpServer();

    // Start MCP authorization server with token exchange support
    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: ['urn:ietf:params:oauth:grant-type:token-exchange'],
      tokenEndpointAuthMethodsSupported: ['none'],
      onTokenRequest: async ({ grantType, body, timestamp }) => {
        if (grantType !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
          this.checks.push({
            id: 'token-exchange-grant-type',
            name: 'TokenExchangeGrantType',
            description: `Expected grant_type=urn:ietf:params:oauth:grant-type:token-exchange, got ${grantType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.RFC_8693_TOKEN_EXCHANGE,
              SpecReferences.SEP_990_ENTERPRISE_OAUTH
            ]
          });
          return {
            error: 'unsupported_grant_type',
            errorDescription: 'Only token exchange grant is supported'
          };
        }

        // Verify subject_token (IDP ID token)
        const subjectToken = body.subject_token;
        const subjectTokenType = body.subject_token_type;

        if (
          !subjectToken ||
          subjectTokenType !== 'urn:ietf:params:oauth:token-type:id_token'
        ) {
          this.checks.push({
            id: 'token-exchange-subject-token',
            name: 'TokenExchangeSubjectToken',
            description: 'Missing or invalid subject_token or subject_token_type',
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE],
            details: {
              hasSubjectToken: !!subjectToken,
              subjectTokenType: subjectTokenType || 'missing'
            }
          });
          return {
            error: 'invalid_request',
            errorDescription: 'Invalid subject_token',
            statusCode: 400
          };
        }

        // Verify the ID token signature
        try {
          const { payload } = await jose.jwtVerify(
            subjectToken,
            this.idpPublicKey!,
            {
              audience: this.authServer.getUrl(),
              issuer: this.idpServer.getUrl()
            }
          );

          this.checks.push({
            id: 'token-exchange-id-token-verified',
            name: 'TokenExchangeIdTokenVerified',
            description:
              'Successfully verified IDP ID token signature and claims',
            status: 'SUCCESS',
            timestamp,
            specReferences: [
              SpecReferences.RFC_8693_TOKEN_EXCHANGE,
              SpecReferences.SEP_990_ENTERPRISE_OAUTH
            ],
            details: {
              sub: payload.sub,
              iss: payload.iss,
              aud: payload.aud
            }
          });

          // Return authorization grant token
          const authorizationGrant = await this.createAuthorizationGrant(
            payload.sub as string
          );

          return {
            token: authorizationGrant,
            scopes: [],
            // RFC 8693 response format
            additionalFields: {
              issued_token_type:
                'urn:ietf:params:oauth:token-type:authorization_grant',
              token_type: 'N_A'
            }
          };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          this.checks.push({
            id: 'token-exchange-id-token-verified',
            name: 'TokenExchangeIdTokenVerified',
            description: `ID token verification failed: ${errorMessage}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE],
            details: { error: errorMessage }
          });
          return {
            error: 'invalid_grant',
            errorDescription: `ID token verification failed: ${errorMessage}`,
            statusCode: 400
          };
        }
      }
    });

    await this.authServer.start(authApp);

    // Start MCP resource server
    const mcpApp = createServer(
      this.checks,
      this.mcpServer.getUrl,
      this.authServer.getUrl
    );

    await this.mcpServer.start(mcpApp);

    // Generate an ID token for the client to use
    const idpIdToken = await createIdpIdToken(
      this.idpPrivateKey!,
      this.idpServer.getUrl(),
      this.authServer.getUrl()
    );

    return {
      serverUrl: `${this.mcpServer.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        idp_id_token: idpIdToken,
        idp_issuer: this.idpServer.getUrl(),
        auth_server_url: this.authServer.getUrl()
      }
    };
  }

  private async startIdpServer(): Promise<void> {
    const app = express();
    app.use(express.json());

    // IDP metadata endpoint
    app.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
      this.checks.push({
        id: 'idp-metadata-discovery',
        name: 'IdpMetadataDiscovery',
        description: 'Client discovered IDP metadata',
        status: 'INFO',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH]
      });

      res.json({
        issuer: this.idpServer.getUrl(),
        authorization_endpoint: `${this.idpServer.getUrl()}/authorize`,
        token_endpoint: `${this.idpServer.getUrl()}/token`,
        jwks_uri: `${this.idpServer.getUrl()}/.well-known/jwks.json`
      });
    });

    await this.idpServer.start(app);
  }

  private async createAuthorizationGrant(userId: string): Promise<string> {
    // Create a simple JWT as authorization grant (in real implementation, this would be opaque)
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
    return await new jose.SignJWT({
      sub: userId,
      grant_type: 'authorization_grant'
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(this.authServer.getUrl())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  async stop() {
    await this.idpServer.stop();
    await this.authServer.stop();
    await this.mcpServer.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the ID token verification check
    const hasIdTokenCheck = this.checks.some(
      (c) => c.id === 'token-exchange-id-token-verified'
    );
    if (!hasIdTokenCheck) {
      this.checks.push({
        id: 'token-exchange-id-token-verified',
        name: 'TokenExchangeIdTokenVerified',
        description: 'Client did not perform token exchange',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_8693_TOKEN_EXCHANGE,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: JWT Bearer Grant Flow (RFC 7523)
 *
 * Tests that the client can exchange an authorization grant for an access token
 * using RFC 7523 JWT Bearer grant.
 */
export class CrossAppAccessJwtBearerScenario implements Scenario {
  name = 'auth/cross-app-access-jwt-bearer';
  description =
    'Tests RFC 7523 JWT Bearer grant flow for exchanging authorization grant for access token (SEP-990)';

  private authServer = new ServerLifecycle();
  private mcpServer = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private grantPublicKey?: CryptoKey;
  private grantPrivateKey?: CryptoKey;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    // Generate keypair for authorization grant
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', {
      extractable: true
    });
    this.grantPublicKey = publicKey;
    this.grantPrivateKey = privateKey;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: [
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'client_credentials'
      ],
      tokenEndpointAuthMethodsSupported: ['none'],
      onTokenRequest: async ({ grantType, body, timestamp, authBaseUrl }) => {
        if (grantType !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          this.checks.push({
            id: 'jwt-bearer-grant-type',
            name: 'JwtBearerGrantType',
            description: `Expected grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer, got ${grantType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_990_ENTERPRISE_OAUTH
            ]
          });
          return {
            error: 'unsupported_grant_type',
            errorDescription: 'Only JWT bearer grant is supported'
          };
        }

        // Verify assertion
        const assertion = body.assertion;
        if (!assertion) {
          this.checks.push({
            id: 'jwt-bearer-assertion',
            name: 'JwtBearerAssertion',
            description: 'Missing assertion parameter',
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_7523_JWT_BEARER]
          });
          return {
            error: 'invalid_request',
            errorDescription: 'Missing assertion',
            statusCode: 400
          };
        }

        // Verify JWT assertion (authorization grant)
        try {
          // Accept both with and without trailing slash for audience
          const withoutSlash = authBaseUrl.replace(/\/+$/, '');
          const withSlash = `${withoutSlash}/`;

          const { payload } = await jose.jwtVerify(assertion, this.grantPublicKey!, {
            audience: [withoutSlash, withSlash],
            clockTolerance: 30
          });

          this.checks.push({
            id: 'jwt-bearer-assertion-verified',
            name: 'JwtBearerAssertionVerified',
            description:
              'Successfully verified authorization grant JWT assertion',
            status: 'SUCCESS',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_990_ENTERPRISE_OAUTH
            ],
            details: {
              sub: payload.sub,
              iss: payload.iss,
              aud: payload.aud
            }
          });

          // Return access token
          const scopes = body.scope ? body.scope.split(' ') : [];
          return {
            token: `test-token-${Date.now()}`,
            scopes
          };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          this.checks.push({
            id: 'jwt-bearer-assertion-verified',
            name: 'JwtBearerAssertionVerified',
            description: `JWT assertion verification failed: ${errorMessage}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [SpecReferences.RFC_7523_JWT_BEARER],
            details: { error: errorMessage }
          });
          return {
            error: 'invalid_grant',
            errorDescription: `JWT assertion verification failed: ${errorMessage}`,
            statusCode: 400
          };
        }
      }
    });

    await this.authServer.start(authApp);

    const mcpApp = createServer(
      this.checks,
      this.mcpServer.getUrl,
      this.authServer.getUrl
    );

    await this.mcpServer.start(mcpApp);

    // Generate an authorization grant for the client to use
    const authorizationGrant = await new jose.SignJWT({
      sub: DEMO_USER_ID,
      grant_type: 'authorization_grant'
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(this.authServer.getUrl())
      .setAudience(this.authServer.getUrl())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.grantPrivateKey!);

    return {
      serverUrl: `${this.mcpServer.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        authorization_grant: authorizationGrant,
        auth_server_url: this.authServer.getUrl()
      }
    };
  }

  async stop() {
    await this.authServer.stop();
    await this.mcpServer.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the JWT bearer check
    const hasJwtBearerCheck = this.checks.some(
      (c) => c.id === 'jwt-bearer-assertion-verified'
    );
    if (!hasJwtBearerCheck) {
      this.checks.push({
        id: 'jwt-bearer-assertion-verified',
        name: 'JwtBearerAssertionVerified',
        description: 'Client did not perform JWT bearer grant exchange',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_7523_JWT_BEARER,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: Complete Cross-App Access Flow
 *
 * Tests the complete SEP-990 flow: IDP ID token -> authorization grant -> access token
 * This scenario combines both RFC 8693 token exchange and RFC 7523 JWT bearer grant.
 */
export class CrossAppAccessCompleteFlowScenario implements Scenario {
  name = 'auth/cross-app-access-complete-flow';
  description =
    'Tests complete SEP-990 flow: token exchange + JWT bearer grant (Enterprise Managed OAuth)';

  private idpServer = new ServerLifecycle();
  private authServer = new ServerLifecycle();
  private mcpServer = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private idpPublicKey?: CryptoKey;
  private idpPrivateKey?: CryptoKey;
  private grantKeypairs: Map<string, CryptoKey> = new Map();

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    // Generate IDP keypair
    const { publicKey, privateKey } = await generateIdpKeypair();
    this.idpPublicKey = publicKey;
    this.idpPrivateKey = privateKey;

    // Start IDP server
    await this.startIdpServer();

    // Start auth server with both token exchange and JWT bearer grant support
    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: [
        'urn:ietf:params:oauth:grant-type:token-exchange',
        'urn:ietf:params:oauth:grant-type:jwt-bearer'
      ],
      tokenEndpointAuthMethodsSupported: ['none'],
      onTokenRequest: async ({ grantType, body, timestamp, authBaseUrl }) => {
        // Handle token exchange (IDP ID token -> authorization grant)
        if (grantType === 'urn:ietf:params:oauth:grant-type:token-exchange') {
          return await this.handleTokenExchange(body, timestamp);
        }

        // Handle JWT bearer grant (authorization grant -> access token)
        if (grantType === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          return await this.handleJwtBearerGrant(
            body,
            timestamp,
            authBaseUrl
          );
        }

        return {
          error: 'unsupported_grant_type',
          errorDescription: `Unsupported grant type: ${grantType}`
        };
      }
    });

    await this.authServer.start(authApp);

    // Start MCP server
    const mcpApp = createServer(
      this.checks,
      this.mcpServer.getUrl,
      this.authServer.getUrl
    );

    await this.mcpServer.start(mcpApp);

    // Generate IDP ID token for client
    const idpIdToken = await createIdpIdToken(
      this.idpPrivateKey!,
      this.idpServer.getUrl(),
      this.authServer.getUrl()
    );

    return {
      serverUrl: `${this.mcpServer.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        idp_id_token: idpIdToken,
        idp_issuer: this.idpServer.getUrl(),
        auth_server_url: this.authServer.getUrl()
      }
    };
  }

  private async startIdpServer(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
      res.json({
        issuer: this.idpServer.getUrl(),
        authorization_endpoint: `${this.idpServer.getUrl()}/authorize`,
        token_endpoint: `${this.idpServer.getUrl()}/token`,
        jwks_uri: `${this.idpServer.getUrl()}/.well-known/jwks.json`
      });
    });

    await this.idpServer.start(app);
  }

  private async handleTokenExchange(
    body: Record<string, string>,
    timestamp: string
  ): Promise<any> {
    const subjectToken = body.subject_token;
    const subjectTokenType = body.subject_token_type;

    if (
      !subjectToken ||
      subjectTokenType !== 'urn:ietf:params:oauth:token-type:id_token'
    ) {
      this.checks.push({
        id: 'complete-flow-token-exchange',
        name: 'CompleteFlowTokenExchange',
        description: 'Invalid token exchange request',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE]
      });
      return {
        error: 'invalid_request',
        errorDescription: 'Invalid subject_token'
      };
    }

    try {
      const { payload } = await jose.jwtVerify(
        subjectToken,
        this.idpPublicKey!,
        {
          audience: this.authServer.getUrl(),
          issuer: this.idpServer.getUrl()
        }
      );

      this.checks.push({
        id: 'complete-flow-token-exchange',
        name: 'CompleteFlowTokenExchange',
        description: 'Successfully exchanged IDP ID token for authorization grant',
        status: 'SUCCESS',
        timestamp,
        specReferences: [
          SpecReferences.RFC_8693_TOKEN_EXCHANGE,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });

      // Create authorization grant
      const userId = payload.sub as string;
      const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
      this.grantKeypairs.set(userId, publicKey);

      const authorizationGrant = await new jose.SignJWT({
        sub: userId,
        grant_type: 'authorization_grant'
      })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(this.authServer.getUrl())
        .setAudience(this.authServer.getUrl())
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      return {
        token: authorizationGrant,
        scopes: [],
        additionalFields: {
          issued_token_type:
            'urn:ietf:params:oauth:token-type:authorization_grant',
          token_type: 'N_A'
        }
      };
    } catch (e) {
      this.checks.push({
        id: 'complete-flow-token-exchange',
        name: 'CompleteFlowTokenExchange',
        description: `Token exchange failed: ${e}`,
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE]
      });
      return {
        error: 'invalid_grant',
        errorDescription: 'Invalid ID token'
      };
    }
  }

  private async handleJwtBearerGrant(
    body: Record<string, string>,
    timestamp: string,
    authBaseUrl: string
  ): Promise<any> {
    const assertion = body.assertion;
    if (!assertion) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description: 'Missing assertion in JWT bearer grant',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.RFC_7523_JWT_BEARER]
      });
      return {
        error: 'invalid_request',
        errorDescription: 'Missing assertion'
      };
    }

    try {
      // Decode without verification first to get subject
      const decoded = jose.decodeJwt(assertion);
      const userId = decoded.sub as string;
      const publicKey = this.grantKeypairs.get(userId);

      if (!publicKey) {
        throw new Error('Unknown authorization grant');
      }

      // Verify with the stored public key
      const withoutSlash = authBaseUrl.replace(/\/+$/, '');
      const withSlash = `${withoutSlash}/`;

      await jose.jwtVerify(assertion, publicKey, {
        audience: [withoutSlash, withSlash],
        clockTolerance: 30
      });

      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description:
          'Successfully exchanged authorization grant for access token',
        status: 'SUCCESS',
        timestamp,
        specReferences: [
          SpecReferences.RFC_7523_JWT_BEARER,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });

      const scopes = body.scope ? body.scope.split(' ') : [];
      return {
        token: `test-token-${Date.now()}`,
        scopes
      };
    } catch (e) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description: `JWT bearer grant failed: ${e}`,
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.RFC_7523_JWT_BEARER]
      });
      return {
        error: 'invalid_grant',
        errorDescription: 'Invalid authorization grant'
      };
    }
  }

  async stop() {
    await this.idpServer.stop();
    await this.authServer.stop();
    await this.mcpServer.stop();
  }

  getChecks(): ConformanceCheck[] {
    const hasTokenExchangeCheck = this.checks.some(
      (c) => c.id === 'complete-flow-token-exchange'
    );
    const hasJwtBearerCheck = this.checks.some(
      (c) => c.id === 'complete-flow-jwt-bearer'
    );

    if (!hasTokenExchangeCheck) {
      this.checks.push({
        id: 'complete-flow-token-exchange',
        name: 'CompleteFlowTokenExchange',
        description: 'Client did not perform token exchange',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_8693_TOKEN_EXCHANGE,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });
    }

    if (!hasJwtBearerCheck) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description: 'Client did not perform JWT bearer grant exchange',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_7523_JWT_BEARER,
          SpecReferences.SEP_990_ENTERPRISE_OAUTH
        ]
      });
    }

    return this.checks;
  }
}
