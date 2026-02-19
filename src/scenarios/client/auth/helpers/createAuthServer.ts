import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import type { ConformanceCheck } from '../../../../types';
import { createRequestLogger } from '../../../request-logger';
import { SpecReferences } from '../spec-references';
import { MockTokenVerifier } from './mockTokenVerifier';

/**
 * Compute S256 code challenge from a code verifier.
 * BASE64URL(SHA256(code_verifier))
 */
function computeS256Challenge(codeVerifier: string): string {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface TokenRequestResult {
  token: string;
  scopes: string[];
}

export interface TokenRequestError {
  error: string;
  errorDescription?: string;
  statusCode?: number;
}

export interface AuthServerOptions {
  metadataPath?: string;
  isOpenIdConfiguration?: boolean;
  loggingEnabled?: boolean;
  routePrefix?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  tokenEndpointAuthSigningAlgValuesSupported?: string[];
  /**
   * Whether to advertise support for Client ID Metadata Documents (CIMD/SEP-991).
   * Defaults to true - CIMD is preferred over DCR when available.
   */
  clientIdMetadataDocumentSupported?: boolean;
  /** Set to true to NOT advertise registration_endpoint (for pre-registration tests) */
  disableDynamicRegistration?: boolean;
  /** PKCE code_challenge_methods_supported. Set to null to omit from metadata. Default: ['S256'] */
  codeChallengeMethodsSupported?: string[] | null;
  tokenVerifier?: MockTokenVerifier;
  onTokenRequest?: (requestData: {
    scope?: string;
    grantType: string;
    timestamp: string;
    body: Record<string, string>;
    authBaseUrl: string;
    tokenEndpoint: string;
    authorizationHeader?: string;
  }) =>
    | TokenRequestResult
    | TokenRequestError
    | Promise<TokenRequestResult | TokenRequestError>;
  onAuthorizationRequest?: (requestData: {
    clientId?: string;
    scope?: string;
    resource?: string;
    timestamp: string;
  }) => void;
  onRegistrationRequest?: (req: Request) => {
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
  };
}

export function createAuthServer(
  checks: ConformanceCheck[],
  getAuthBaseUrl: () => string,
  options: AuthServerOptions = {}
): express.Application {
  const {
    metadataPath = '/.well-known/oauth-authorization-server',
    isOpenIdConfiguration = false,
    loggingEnabled = true,
    routePrefix = '',
    scopesSupported,
    grantTypesSupported = ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethodsSupported = ['none'],
    tokenEndpointAuthSigningAlgValuesSupported,
    // Default to true - CIMD is preferred over DCR
    clientIdMetadataDocumentSupported = true,
    disableDynamicRegistration = false,
    codeChallengeMethodsSupported = ['S256'],
    tokenVerifier,
    onTokenRequest,
    onAuthorizationRequest,
    onRegistrationRequest
  } = options;

  // Track scopes from the most recent authorization request
  let lastAuthorizationScopes: string[] = [];
  // Track PKCE code_challenge for verification in token request
  let storedCodeChallenge: string | undefined;

  const authRoutes = {
    authorization_endpoint: `${routePrefix}/authorize`,
    token_endpoint: `${routePrefix}/token`,
    registration_endpoint: `${routePrefix}/register`,
    introspection_endpoint: `${routePrefix}/introspect`
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  if (loggingEnabled) {
    app.use(
      createRequestLogger(checks, {
        incomingId: 'incoming-auth-request',
        outgoingId: 'outgoing-auth-response'
      })
    );
  }

  app.get(metadataPath, (req: Request, res: Response) => {
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

    const metadata: any = {
      issuer: getAuthBaseUrl(),
      authorization_endpoint: `${getAuthBaseUrl()}${authRoutes.authorization_endpoint}`,
      token_endpoint: `${getAuthBaseUrl()}${authRoutes.token_endpoint}`,
      ...(!disableDynamicRegistration && {
        registration_endpoint: `${getAuthBaseUrl()}${authRoutes.registration_endpoint}`
      }),
      introspection_endpoint: `${getAuthBaseUrl()}${authRoutes.introspection_endpoint}`,
      response_types_supported: ['code'],
      grant_types_supported: grantTypesSupported,
      // PKCE support - null means omit from metadata (for negative testing)
      ...(codeChallengeMethodsSupported !== null && {
        code_challenge_methods_supported: codeChallengeMethodsSupported
      }),
      token_endpoint_auth_methods_supported: tokenEndpointAuthMethodsSupported,
      ...(tokenEndpointAuthSigningAlgValuesSupported && {
        token_endpoint_auth_signing_alg_values_supported:
          tokenEndpointAuthSigningAlgValuesSupported
      })
    };

    // Add scopes_supported if provided
    if (scopesSupported !== undefined) {
      metadata.scopes_supported = scopesSupported;
    }

    // Add client_id_metadata_document_supported if provided
    if (clientIdMetadataDocumentSupported !== undefined) {
      metadata.client_id_metadata_document_supported =
        clientIdMetadataDocumentSupported;
    }

    // Add OpenID Configuration specific fields
    if (isOpenIdConfiguration) {
      metadata.jwks_uri = `${getAuthBaseUrl()}/.well-known/jwks.json`;
      metadata.subject_types_supported = ['public'];
      metadata.id_token_signing_alg_values_supported = ['RS256'];
    }

    res.json(metadata);
  });

  app.get(authRoutes.authorization_endpoint, (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const clientId = req.query.client_id as string | undefined;

    // Check if client is using CIMD (URL-based client ID)
    const isUrlBasedClientId =
      clientId &&
      (clientId.startsWith('https://') || clientId.startsWith('http://'));

    if (isUrlBasedClientId) {
      checks.push({
        id: 'cimd-client-id',
        name: 'CIMDClientId',
        description:
          'Client used URL-based client ID (CIMD/SEP-991) instead of DCR',
        status: 'SUCCESS',
        timestamp,
        specReferences: [SpecReferences.MCP_DCR],
        details: {
          clientId
        }
      });
    }

    checks.push({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_ENDPOINT],
      details: {
        query: req.query
      }
    });

    // PKCE: Store code_challenge for later verification
    const codeChallenge = req.query.code_challenge as string | undefined;
    const codeChallengeMethod = req.query.code_challenge_method as
      | string
      | undefined;
    storedCodeChallenge = codeChallenge;

    // PKCE: Check code_challenge is present
    checks.push({
      id: 'pkce-code-challenge-sent',
      name: 'PKCE Code Challenge',
      description: codeChallenge
        ? 'Client sent code_challenge in authorization request'
        : 'Client MUST send code_challenge in authorization request',
      status: codeChallenge ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SpecReferences.MCP_PKCE]
    });

    // PKCE: Check S256 method is used
    checks.push({
      id: 'pkce-s256-method-used',
      name: 'PKCE S256 Method',
      description:
        codeChallengeMethod === 'S256'
          ? 'Client used S256 code challenge method'
          : 'Client MUST use S256 code challenge method when technically capable',
      status: codeChallengeMethod === 'S256' ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SpecReferences.MCP_PKCE],
      details: {
        method: codeChallengeMethod || 'not specified'
      }
    });

    // Track scopes from authorization request for token issuance
    const scopeParam = req.query.scope as string | undefined;
    lastAuthorizationScopes = scopeParam ? scopeParam.split(' ') : [];

    if (onAuthorizationRequest) {
      onAuthorizationRequest({
        clientId,
        scope: scopeParam,
        resource: req.query.resource as string | undefined,
        timestamp
      });
    }

    const redirectUri = req.query.redirect_uri as string;
    const state = req.query.state as string;
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', 'test-auth-code');
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    res.redirect(redirectUrl.toString());
  });

  app.post(authRoutes.token_endpoint, async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const requestedScope = req.body.scope;
    const grantType = req.body.grant_type;

    checks.push({
      id: 'token-request',
      name: 'TokenRequest',
      description: 'Client requested access token',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
      details: {
        endpoint: '/token',
        grantType
      }
    });

    // PKCE: Check code_verifier is present (only for authorization_code grant)
    const codeVerifier = req.body.code_verifier as string | undefined;
    if (grantType === 'authorization_code') {
      checks.push({
        id: 'pkce-code-verifier-sent',
        name: 'PKCE Code Verifier',
        description: codeVerifier
          ? 'Client sent code_verifier in token request'
          : 'Client MUST send code_verifier in token request',
        status: codeVerifier ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.MCP_PKCE]
      });

      // PKCE: Validate code_verifier matches code_challenge (S256)
      // Fail if either is missing
      const computedChallenge =
        codeVerifier && storedCodeChallenge
          ? computeS256Challenge(codeVerifier)
          : undefined;
      const matches =
        computedChallenge !== undefined &&
        computedChallenge === storedCodeChallenge;

      let description: string;
      if (!storedCodeChallenge && !codeVerifier) {
        description =
          'Neither code_challenge nor code_verifier were sent - PKCE is required';
      } else if (!storedCodeChallenge) {
        description =
          'code_challenge was not sent in authorization request - PKCE is required';
      } else if (!codeVerifier) {
        description =
          'code_verifier was not sent in token request - PKCE is required';
      } else if (matches) {
        description = 'code_verifier correctly matches code_challenge (S256)';
      } else {
        description = 'code_verifier does not match code_challenge';
      }

      checks.push({
        id: 'pkce-verifier-matches-challenge',
        name: 'PKCE Verifier Validation',
        description,
        status: matches ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.MCP_PKCE],
        details: {
          matches,
          storedChallenge: storedCodeChallenge || 'not sent',
          computedChallenge: computedChallenge || 'not computed'
        }
      });
    }

    let token = `test-token-${Date.now()}`;
    let scopes: string[] = lastAuthorizationScopes;

    if (onTokenRequest) {
      const result = await onTokenRequest({
        scope: requestedScope,
        grantType,
        timestamp,
        body: req.body,
        authBaseUrl: getAuthBaseUrl(),
        tokenEndpoint: `${getAuthBaseUrl()}${authRoutes.token_endpoint}`,
        authorizationHeader: req.headers.authorization
      });

      // Check if result is an error
      if ('error' in result) {
        res.status(result.statusCode || 400).json({
          error: result.error,
          error_description: result.errorDescription
        });
        return;
      }

      token = result.token;
      scopes = result.scopes;
    }

    // Register token with verifier if provided
    if (tokenVerifier) {
      tokenVerifier.registerToken(token, scopes);
    }

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      ...(scopes.length > 0 && { scope: scopes.join(' ') })
    });
  });

  app.post(authRoutes.registration_endpoint, (req: Request, res: Response) => {
    let clientId = 'test-client-id';
    let clientSecret: string | undefined = 'test-client-secret';
    let tokenEndpointAuthMethod: string | undefined;

    if (onRegistrationRequest) {
      const result = onRegistrationRequest(req);
      clientId = result.clientId;
      clientSecret = result.clientSecret;
      tokenEndpointAuthMethod = result.tokenEndpointAuthMethod;
    }

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
        ...(tokenEndpointAuthMethod && { tokenEndpointAuthMethod })
      }
    });

    res.status(201).json({
      client_id: clientId,
      ...(clientSecret && { client_secret: clientSecret }),
      client_name: req.body.client_name || 'test-client',
      redirect_uris: req.body.redirect_uris || [],
      ...(tokenEndpointAuthMethod && {
        token_endpoint_auth_method: tokenEndpointAuthMethod
      })
    });
  });

  // Token introspection endpoint (RFC 7662)
  app.post(
    authRoutes.introspection_endpoint,
    async (req: Request, res: Response) => {
      const { token } = req.body;

      if (!token) {
        res.status(400).json({ error: 'Token is required' });
        return;
      }

      // If we have a tokenVerifier, use it to validate
      if (tokenVerifier) {
        try {
          const tokenInfo = await tokenVerifier.verifyAccessToken(token);
          res.json({
            active: true,
            client_id: tokenInfo.clientId,
            scope: tokenInfo.scopes.join(' '),
            exp: tokenInfo.expiresAt
          });
          return;
        } catch {
          res.json({ active: false });
          return;
        }
      }

      // Fallback: accept tokens with known prefixes
      if (token.startsWith('test-token') || token.startsWith('cc-token')) {
        res.json({
          active: true,
          client_id: 'test-client',
          scope: '',
          exp: Math.floor(Date.now() / 1000) + 3600
        });
        return;
      }

      res.json({ active: false });
    }
  );

  return app;
}
