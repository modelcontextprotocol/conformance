import type { ScenarioContext } from '../../../mock-server';
import * as jose from 'jose';
import type { CryptoKey } from 'jose';
import express, { type Request, type Response } from 'express';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Scenario, ConformanceCheck, ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { JWT_BEARER_GRANT_TYPE } from './helpers/createWorkloadJwt.js';
import { createServer } from './helpers/createServer';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';

const CONFORMANCE_TEST_CLIENT_ID = 'conformance-test-xaa-client';
const CONFORMANCE_TEST_CLIENT_SECRET = 'conformance-test-xaa-secret';
const IDP_CLIENT_ID = 'conformance-test-idp-client';
const IDP_CLIENT_SECRET = 'conformance-test-idp-secret';
const DEMO_USER_ID = 'demo-user@example.com';
const REFRESH_TOKEN_SCOPES = ['test:read', 'test:write'];
const GRANTED_SCOPE = 'test:read';

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
 * Scenario: Enterprise-Managed Authorization (SEP-990)
 *
 * Tests the complete SEP-990 flow: IdP subject token -> ID-JAG -> access token.
 * This scenario combines both RFC 8693 token exchange and RFC 7523 JWT bearer grant.
 */
export class EnterpriseManagedAuthorizationScenario implements Scenario {
  readonly name: string;
  readonly source = {
    extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
  } as const;
  readonly description: string;

  constructor(
    private readonly subjectTokenType: 'id_token' | 'refresh_token' = 'id_token'
  ) {
    this.name =
      subjectTokenType === 'id_token'
        ? 'auth/enterprise-managed-authorization'
        : 'auth/enterprise-managed-authorization-refresh-token';
    this.description =
      subjectTokenType === 'id_token'
        ? 'Tests complete SEP-990 flow: token exchange + JWT bearer grant (Enterprise-Managed Authorization)'
        : 'Tests clients supporting optional EMA refresh-token exchange: refresh token -> ID-JAG -> scoped MCP access';
  }

  private idpServer = new ServerLifecycle();
  private authServer = new ServerLifecycle();
  private mcpServer = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private idpPublicKey?: CryptoKey;
  private idpPrivateKey?: CryptoKey;
  private grantKeypairs: Map<string, CryptoKey> = new Map();
  private refreshToken?: { token: string; expiresAt: number };
  private issuedAccessTokens = new Set<string>();

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    this.grantKeypairs.clear();
    this.issuedAccessTokens.clear();
    // Seed a previously issued, client-bound IdP refresh token.
    this.refreshToken =
      this.subjectTokenType === 'refresh_token'
        ? { token: crypto.randomUUID(), expiresAt: Date.now() + 3600_000 }
        : undefined;

    // Generate IDP keypair
    const { publicKey, privateKey } = await generateIdpKeypair();
    this.idpPublicKey = publicKey;
    this.idpPrivateKey = privateKey;

    // Shared token verifier ensures MCP server only accepts tokens
    // actually issued by the auth server
    const tokenVerifier = new MockTokenVerifier(this.checks, []);
    if (this.subjectTokenType === 'refresh_token') {
      const verifyAccessToken =
        tokenVerifier.verifyAccessToken.bind(tokenVerifier);
      tokenVerifier.verifyAccessToken = async (token) => {
        if (!this.issuedAccessTokens.has(token)) {
          this.checks.push({
            id: 'complete-flow-mcp-access',
            name: 'CompleteFlowMcpAccess',
            description:
              'Client used an access token not issued by this scenario',
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE]
          });
          throw new InvalidTokenError('Token was not issued by this scenario');
        }
        return verifyAccessToken(token);
      };
    }

    // Start IDP server
    await this.startIdpServer();

    // Start auth server with JWT bearer grant support only
    // Token exchange is handled by IdP
    const authApp = createAuthServer(ctx, this.checks, this.authServer.getUrl, {
      grantTypesSupported: [JWT_BEARER_GRANT_TYPE],
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
        if (grantType === JWT_BEARER_GRANT_TYPE) {
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
      ctx,
      this.checks,
      this.mcpServer.getUrl,
      this.authServer.getUrl,
      {
        tokenVerifier,
        ...(this.subjectTokenType === 'refresh_token' && {
          scopesSupported: REFRESH_TOKEN_SCOPES,
          requiredScopes: [GRANTED_SCOPE],
          includeScopeInWwwAuth: true,
          onMcpOperation: () =>
            this.checks.push({
              id: 'complete-flow-mcp-access',
              name: 'CompleteFlowMcpAccess',
              description:
                'Client completed an MCP operation with the issued access token',
              status: 'SUCCESS',
              timestamp: new Date().toISOString(),
              specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE]
            })
        })
      }
    );

    await this.mcpServer.start(mcpApp);

    const subjectContext = this.refreshToken
      ? {
          idp_refresh_token: this.refreshToken.token,
          idp_client_secret: IDP_CLIENT_SECRET
        }
      : {
          idp_id_token: await createIdpIdToken(
            this.idpPrivateKey!,
            this.idpServer.getUrl(),
            IDP_CLIENT_ID
          )
        };

    return {
      serverUrl: `${this.mcpServer.getUrl()}/mcp`,
      context: {
        client_id: CONFORMANCE_TEST_CLIENT_ID,
        client_secret: CONFORMANCE_TEST_CLIENT_SECRET,
        idp_client_id: IDP_CLIENT_ID,
        ...subjectContext,
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
          ],
          ...(this.subjectTokenType === 'refresh_token' && {
            token_endpoint_auth_methods_supported: ['client_secret_basic']
          })
        });
      }
    );

    // IdP token endpoint - exchanges either supported subject token for an ID-JAG.
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
      const expectedSubjectType = `urn:ietf:params:oauth:token-type:${this.subjectTokenType}`;
      if (subjectTokenType !== expectedSubjectType) {
        missingParams.push(
          `subject_token_type (expected ${expectedSubjectType}, got ${subjectTokenType || 'missing'})`
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
        let userId: string;
        let grantedScope: string | undefined;
        if (this.subjectTokenType === 'refresh_token') {
          const expectedAuth = `Basic ${Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64')}`;
          if (
            req.headers.authorization !== expectedAuth ||
            (req.body.client_id !== undefined &&
              req.body.client_id !== IDP_CLIENT_ID)
          ) {
            this.checks.push({
              id: 'complete-flow-token-exchange',
              name: 'CompleteFlowTokenExchange',
              description:
                'Refresh-token exchange requires the bound IdP client credentials',
              status: 'FAILURE',
              timestamp,
              specReferences: [SpecReferences.ID_JAG_REFRESH_TOKEN]
            });
            res.status(401).json({ error: 'invalid_client' });
            return;
          }
          if (
            !this.refreshToken ||
            subjectToken !== this.refreshToken.token ||
            this.refreshToken.expiresAt <= Date.now()
          ) {
            throw new Error('Invalid or expired IdP refresh token');
          }
          if (
            audience !== this.authServer.getUrl() ||
            resource !== `${this.mcpServer.getUrl()}/mcp`
          ) {
            throw new Error(
              'Requested audience or resource is outside the refresh token authorization'
            );
          }
          const requestedScopes =
            req.body.scope === undefined
              ? [GRANTED_SCOPE]
              : typeof req.body.scope === 'string'
                ? req.body.scope.split(' ')
                : [];
          if (
            requestedScopes.length === 0 ||
            requestedScopes.some(
              (scope: string) => !REFRESH_TOKEN_SCOPES.includes(scope)
            ) ||
            !requestedScopes.includes(GRANTED_SCOPE)
          ) {
            throw new Error(
              'Requested scope is outside the refresh token authorization'
            );
          }
          userId = DEMO_USER_ID;
          grantedScope = GRANTED_SCOPE;
        } else {
          const { payload } = await jose.jwtVerify(
            subjectToken,
            this.idpPublicKey!,
            {
              audience: IDP_CLIENT_ID,
              issuer: this.idpServer.getUrl()
            }
          );
          userId = payload.sub as string;
        }

        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description: `Successfully exchanged IdP ${this.subjectTokenType} for ID-JAG with all required parameters`,
          status: 'SUCCESS',
          timestamp,
          specReferences: [
            SpecReferences.RFC_8693_TOKEN_EXCHANGE,
            SpecReferences.SEP_990_ENTERPRISE_OAUTH,
            ...(this.subjectTokenType === 'refresh_token'
              ? [SpecReferences.ID_JAG_REFRESH_TOKEN]
              : [])
          ]
        });

        // Create ID-JAG (ID-bound JSON Assertion Grant)
        // Include resource and client_id claims per SEP-990
        const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
        this.grantKeypairs.set(userId, publicKey);

        // The IdP uses CONFORMANCE_TEST_CLIENT_ID (the MCP Client's client_id
        // at the AS), not the IdP client_id from the request body.
        // Per Section 6.1: "the IdP will need to be aware of the MCP Client's
        // client_id that it normally uses with the MCP Server."
        const idJag = await new jose.SignJWT({
          sub: userId,
          resource: resource,
          client_id: CONFORMANCE_TEST_CLIENT_ID,
          ...(grantedScope && { scope: grantedScope })
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
          token_type: 'N_A',
          ...(grantedScope && { scope: grantedScope, expires_in: 300 })
        });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.checks.push({
          id: 'complete-flow-token-exchange',
          name: 'CompleteFlowTokenExchange',
          description: `Token exchange failed: ${errorMessage}`,
          status: 'FAILURE',
          timestamp,
          specReferences: [
            SpecReferences.RFC_8693_TOKEN_EXCHANGE,
            ...(this.subjectTokenType === 'refresh_token'
              ? [SpecReferences.ID_JAG_REFRESH_TOKEN]
              : [])
          ]
        });
        res.status(400).json({
          error: 'invalid_grant',
          error_description: `Invalid ${this.subjectTokenType} exchange`
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
        ...(this.subjectTokenType === 'refresh_token' && {
          issuer: this.idpServer.getUrl()
        }),
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

      let scopes = body.scope ? body.scope.split(' ') : [];
      if (this.subjectTokenType === 'refresh_token') {
        // The signed grant bounds the access token, even when scope is omitted.
        const grantedScopes =
          typeof decoded.scope === 'string' ? decoded.scope.split(' ') : [];
        scopes =
          body.scope === undefined ? grantedScopes : body.scope.split(' ');
        if (
          grantedScopes.length === 0 ||
          scopes.some((scope) => !grantedScopes.includes(scope))
        ) {
          throw new Error(
            'Requested access-token scope exceeds the ID-JAG grant'
          );
        }
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

      const token = `test-token-${crypto.randomUUID()}`;
      this.issuedAccessTokens.add(token);
      return {
        token,
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
    this.refreshToken = undefined;
    this.issuedAccessTokens.clear();
    await this.idpServer.stop();
    await this.authServer.stop();
    await this.mcpServer.stop();
  }

  getChecks(): ConformanceCheck[] {
    if (
      this.subjectTokenType === 'refresh_token' &&
      !this.checks.some((check) => check.id === 'complete-flow-mcp-access')
    ) {
      this.checks.push({
        id: 'complete-flow-mcp-access',
        name: 'CompleteFlowMcpAccess',
        description:
          'Client did not complete an MCP operation with the issued access token',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE]
      });
    }
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
