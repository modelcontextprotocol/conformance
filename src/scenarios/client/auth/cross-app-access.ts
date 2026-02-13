import * as jose from 'jose';
import type { CryptoKey } from 'jose';
import express, { type Request, type Response } from 'express';
import type { Scenario, ConformanceCheck, ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';

const CONFORMANCE_TEST_CLIENT_ID = 'conformance-test-xaa-client';
const CONFORMANCE_TEST_CLIENT_SECRET = 'conformance-test-xaa-secret';
const IDP_CLIENT_ID = 'conformance-test-idp-client';
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

    // Shared token verifier ensures MCP server only accepts tokens
    // actually issued by the auth server
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    // Start IDP server
    await this.startIdpServer();

    // Start auth server with JWT bearer grant support only
    // Token exchange is handled by IdP
    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
      tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
      tokenVerifier,
      onTokenRequest: async ({
        grantType,
        body,
        timestamp,
        authBaseUrl,
        authorizationHeader
      }) => {
        // Auth server only handles JWT bearer grant (ID-JAG -> access token)
        if (grantType === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          const mcpResourceUrl = `${this.mcpServer.getUrl()}/mcp`;
          return await this.handleJwtBearerGrant(
            body,
            timestamp,
            authBaseUrl,
            authorizationHeader,
            mcpResourceUrl
          );
        }

        return {
          error: 'unsupported_grant_type',
          errorDescription: `Auth server only supports jwt-bearer grant, got ${grantType}`
        };
      }
    });

    await this.authServer.start(authApp);

    // Start MCP server with shared token verifier
    const mcpApp = createServer(
      this.checks,
      this.mcpServer.getUrl,
      this.authServer.getUrl,
      { tokenVerifier }
    );

    await this.mcpServer.start(mcpApp);

    // Generate IDP ID token for client
    const idpIdToken = await createIdpIdToken(
      this.idpPrivateKey!,
      this.idpServer.getUrl(),
      IDP_CLIENT_ID
    );

    return {
      serverUrl: `${this.mcpServer.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        client_secret: CONFORMANCE_TEST_CLIENT_SECRET,
        idp_client_id: IDP_CLIENT_ID,
        idp_id_token: idpIdToken,
        idp_issuer: this.idpServer.getUrl(),
        idp_token_endpoint: `${this.idpServer.getUrl()}/token`
      }
    };
  }

  private async startIdpServer(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // IDP metadata endpoint
    app.get(
      '/.well-known/openid-configuration',
      (req: Request, res: Response) => {
        res.json({
          issuer: this.idpServer.getUrl(),
          authorization_endpoint: `${this.idpServer.getUrl()}/authorize`,
          token_endpoint: `${this.idpServer.getUrl()}/token`,
          jwks_uri: `${this.idpServer.getUrl()}/.well-known/jwks.json`,
          grant_types_supported: [
            'urn:ietf:params:oauth:grant-type:token-exchange'
          ]
        });
      }
    );

    // IDP token endpoint - handles token exchange (IDP ID token -> ID-JAG)
    app.post('/token', async (req: Request, res: Response) => {
      const timestamp = new Date().toISOString();
      const grantType = req.body.grant_type;
      const subjectToken = req.body.subject_token;
      const subjectTokenType = req.body.subject_token_type;
      const requestedTokenType = req.body.requested_token_type;
      const audience = req.body.audience;
      const resource = req.body.resource;

      // Only handle token exchange at IdP
      if (grantType !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description: `IdP expected token-exchange grant, got ${grantType}`,
          status: 'FAILURE',
          timestamp,
          specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE]
        });
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'IdP only supports token-exchange'
        });
        return;
      }

      // Verify all required token exchange parameters per SEP-990
      const missingParams: string[] = [];
      if (!subjectToken) missingParams.push('subject_token');
      if (subjectTokenType !== 'urn:ietf:params:oauth:token-type:id_token') {
        missingParams.push(
          `subject_token_type (expected urn:ietf:params:oauth:token-type:id_token, got ${subjectTokenType || 'missing'})`
        );
      }
      if (requestedTokenType !== 'urn:ietf:params:oauth:token-type:id-jag') {
        missingParams.push(
          `requested_token_type (expected urn:ietf:params:oauth:token-type:id-jag, got ${requestedTokenType || 'missing'})`
        );
      }
      if (!audience) missingParams.push('audience');
      if (!resource) missingParams.push('resource');

      if (missingParams.length > 0) {
        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description: `Token exchange missing or invalid required parameters: ${missingParams.join(', ')}`,
          status: 'FAILURE',
          timestamp,
          specReferences: [
            SpecReferences.RFC_8693_TOKEN_EXCHANGE,
            SpecReferences.SEP_990_ENTERPRISE_OAUTH
          ]
        });
        res.status(400).json({
          error: 'invalid_request',
          error_description: `Missing or invalid required parameters: ${missingParams.join(', ')}`
        });
        return;
      }

      try {
        // Verify the IDP ID token
        const { payload } = await jose.jwtVerify(
          subjectToken,
          this.idpPublicKey!,
          {
            audience: IDP_CLIENT_ID,
            issuer: this.idpServer.getUrl()
          }
        );

        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description:
            'Successfully exchanged IDP ID token for ID-JAG at IdP with all required parameters',
          status: 'SUCCESS',
          timestamp,
          specReferences: [
            SpecReferences.RFC_8693_TOKEN_EXCHANGE,
            SpecReferences.SEP_990_ENTERPRISE_OAUTH
          ]
        });

        // Create ID-JAG (ID-bound JSON Assertion Grant)
        // Include resource and client_id claims per SEP-990
        const userId = payload.sub as string;
        const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
        this.grantKeypairs.set(userId, publicKey);

        // The IdP uses CONFORMANCE_TEST_CLIENT_ID (the MCP Client's client_id
        // at the AS), not the IdP client_id from the request body.
        // Per Section 6.1: "the IdP will need to be aware of the MCP Client's
        // client_id that it normally uses with the MCP Server."
        const idJag = await new jose.SignJWT({
          sub: userId,
          resource: resource,
          client_id: CONFORMANCE_TEST_CLIENT_ID
        })
          .setProtectedHeader({ alg: 'ES256', typ: 'oauth-id-jag+jwt' })
          .setIssuer(this.idpServer.getUrl())
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti(crypto.randomUUID())
          .sign(privateKey);

        res.json({
          access_token: idJag,
          issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
          token_type: 'N_A'
        });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description: `Token exchange failed: ${errorMessage}`,
          status: 'FAILURE',
          timestamp,
          specReferences: [SpecReferences.RFC_8693_TOKEN_EXCHANGE]
        });
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid ID token'
        });
      }
    });

    await this.idpServer.start(app);
  }

  private async handleJwtBearerGrant(
    body: Record<string, string>,
    timestamp: string,
    authBaseUrl: string,
    authorizationHeader?: string,
    mcpResourceUrl?: string
  ): Promise<any> {
    // 1. Verify client authentication (client_secret_basic)
    if (!authorizationHeader || !authorizationHeader.startsWith('Basic ')) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description:
          'Missing or invalid Authorization header for client_secret_basic authentication',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH],
        details: {
          expected: 'Authorization: Basic <base64(client_id:client_secret)>',
          received: authorizationHeader || 'missing'
        }
      });
      return {
        error: 'invalid_client',
        errorDescription:
          'Client authentication required (client_secret_basic)',
        statusCode: 401
      };
    }

    const base64Credentials = authorizationHeader.slice('Basic '.length);
    const decoded = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description: 'Malformed Basic auth header (no colon separator)',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH]
      });
      return {
        error: 'invalid_client',
        errorDescription: 'Malformed Basic auth',
        statusCode: 401
      };
    }

    const authClientId = decodeURIComponent(decoded.slice(0, separatorIndex));
    const authClientSecret = decodeURIComponent(
      decoded.slice(separatorIndex + 1)
    );

    if (
      authClientId !== CONFORMANCE_TEST_CLIENT_ID ||
      authClientSecret !== CONFORMANCE_TEST_CLIENT_SECRET
    ) {
      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description: `Client authentication failed: invalid credentials (client_id: ${authClientId})`,
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH]
      });
      return {
        error: 'invalid_client',
        errorDescription: 'Invalid client credentials',
        statusCode: 401
      };
    }

    // 2. Verify assertion is present
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
      // 3. Verify the ID-JAG header has the correct typ
      const header = jose.decodeProtectedHeader(assertion);
      if (header.typ !== 'oauth-id-jag+jwt') {
        this.checks.push({
          id: 'complete-flow-jwt-bearer',
          name: 'CompleteFlowJwtBearer',
          description: `ID-JAG has wrong typ header: expected oauth-id-jag+jwt, got ${header.typ}`,
          status: 'FAILURE',
          timestamp,
          specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH]
        });
        return {
          error: 'invalid_grant',
          errorDescription: 'Invalid ID-JAG typ header'
        };
      }

      // 4. Decode and verify the ID-JAG
      const decoded = jose.decodeJwt(assertion);
      const userId = decoded.sub as string;
      const publicKey = this.grantKeypairs.get(userId);

      if (!publicKey) {
        throw new Error('Unknown authorization grant');
      }

      // Verify signature and audience
      const withoutSlash = authBaseUrl.replace(/\/+$/, '');
      const withSlash = `${withoutSlash}/`;

      await jose.jwtVerify(assertion, publicKey, {
        audience: [withoutSlash, withSlash],
        clockTolerance: 30
      });

      // 5. Verify client_id in ID-JAG matches the authenticating client (Section 5.1)
      const jagClientId = decoded.client_id as string | undefined;
      if (jagClientId !== authClientId) {
        this.checks.push({
          id: 'complete-flow-jwt-bearer',
          name: 'CompleteFlowJwtBearer',
          description: `ID-JAG client_id (${jagClientId}) does not match authenticating client (${authClientId})`,
          status: 'FAILURE',
          timestamp,
          specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH],
          details: {
            jagClientId,
            authClientId
          }
        });
        return {
          error: 'invalid_grant',
          errorDescription:
            'ID-JAG client_id does not match authenticating client'
        };
      }

      // 6. Verify resource claim in ID-JAG matches the MCP server resource
      const jagResource = decoded.resource as string | undefined;
      if (mcpResourceUrl && jagResource !== mcpResourceUrl) {
        this.checks.push({
          id: 'complete-flow-jwt-bearer',
          name: 'CompleteFlowJwtBearer',
          description: `ID-JAG resource (${jagResource}) does not match MCP server resource (${mcpResourceUrl})`,
          status: 'FAILURE',
          timestamp,
          specReferences: [SpecReferences.SEP_990_ENTERPRISE_OAUTH],
          details: {
            jagResource,
            expectedResource: mcpResourceUrl
          }
        });
        return {
          error: 'invalid_grant',
          errorDescription: 'ID-JAG resource does not match MCP server resource'
        };
      }

      this.checks.push({
        id: 'complete-flow-jwt-bearer',
        name: 'CompleteFlowJwtBearer',
        description:
          'Successfully verified client auth, ID-JAG claims, and exchanged for access token',
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
