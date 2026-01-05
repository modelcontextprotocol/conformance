import express, { Request, Response } from 'express';
import type { ConformanceCheck } from '../../../../types';
import { createRequestLogger } from '../../../request-logger';
import { SpecReferences } from '../spec-references';
import { MockTokenVerifier } from './mockTokenVerifier';

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
  clientIdMetadataDocumentSupported?: boolean;
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
    clientIdMetadataDocumentSupported,
    tokenVerifier,
    onTokenRequest,
    onAuthorizationRequest,
    onRegistrationRequest
  } = options;

  // Track scopes from the most recent authorization request
  let lastAuthorizationScopes: string[] = [];

  const authRoutes = {
    authorization_endpoint: `${routePrefix}/authorize`,
    token_endpoint: `${routePrefix}/token`,
    registration_endpoint: `${routePrefix}/register`
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
      registration_endpoint: `${getAuthBaseUrl()}${authRoutes.registration_endpoint}`,
      response_types_supported: ['code'],
      grant_types_supported: grantTypesSupported,
      code_challenge_methods_supported: ['S256'],
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

    // Track scopes from authorization request for token issuance
    const scopeParam = req.query.scope as string | undefined;
    lastAuthorizationScopes = scopeParam ? scopeParam.split(' ') : [];

    if (onAuthorizationRequest) {
      onAuthorizationRequest({
        clientId: req.query.client_id as string | undefined,
        scope: scopeParam,
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

  return app;
}
