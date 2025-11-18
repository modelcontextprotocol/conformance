import express, { Request, Response } from 'express';
import type { ConformanceCheck } from '../../../../types.js';
import { createRequestLogger } from '../../../request-logger.js';
import { SpecReferences } from '../spec-references.js';
import { MockTokenVerifier } from './mockTokenVerifier.js';

export interface AuthServerOptions {
  metadataPath?: string;
  isOpenIdConfiguration?: boolean;
  loggingEnabled?: boolean;
  routePrefix?: string;
  scopesSupported?: string[];
  tokenVerifier?: MockTokenVerifier;
  onTokenRequest?: (requestData: {
    scope?: string;
    grantType: string;
    timestamp: string;
  }) => { token: string; scopes: string[] };
  onAuthorizationRequest?: (requestData: {
    scope?: string;
    timestamp: string;
  }) => void;
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
    tokenVerifier,
    onTokenRequest,
    onAuthorizationRequest
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
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    };

    // Add scopes_supported if provided
    if (scopesSupported !== undefined) {
      metadata.scopes_supported = scopesSupported;
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

  app.post(authRoutes.token_endpoint, (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const requestedScope = req.body.scope;

    checks.push({
      id: 'token-request',
      name: 'TokenRequest',
      description: 'Client requested access token',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
      details: {
        endpoint: '/token',
        grantType: req.body.grant_type
      }
    });

    let token = `test-token-${Date.now()}`;
    let scopes: string[] = lastAuthorizationScopes;

    if (onTokenRequest) {
      const result = onTokenRequest({
        scope: requestedScope,
        grantType: req.body.grant_type,
        timestamp
      });
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
    checks.push({
      id: 'client-registration',
      name: 'ClientRegistration',
      description: 'Client registered with authorization server',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.MCP_DCR],
      details: {
        endpoint: '/register',
        clientName: req.body.client_name
      }
    });

    res.status(201).json({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      client_name: req.body.client_name || 'test-client',
      redirect_uris: req.body.redirect_uris || []
    });
  });

  return app;
}
