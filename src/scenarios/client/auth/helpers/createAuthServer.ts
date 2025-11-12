import express, { Request, Response } from 'express';
import type { ConformanceCheck } from '../../../../types.js';
import { createRequestLogger } from '../../../request-logger.js';

export interface AuthServerOptions {
  metadataPath?: string;
  isOpenIdConfiguration?: boolean;
  loggingEnabled?: boolean;
  routePrefix?: string;
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
    routePrefix = ''
  } = options;

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
        {
          id: 'RFC-8414',
          url: 'https://tools.ietf.org/html/rfc8414'
        }
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

    // Add OpenID Configuration specific fields
    if (isOpenIdConfiguration) {
      metadata.jwks_uri = `${getAuthBaseUrl()}/.well-known/jwks.json`;
      metadata.subject_types_supported = ['public'];
      metadata.id_token_signing_alg_values_supported = ['RS256'];
    }

    res.json(metadata);
  });

  app.get(authRoutes.authorization_endpoint, (req: Request, res: Response) => {
    checks.push({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'RFC-6749-4.1.1',
          url: 'https://tools.ietf.org/html/rfc6749#section-4.1.1'
        }
      ],
      details: {
        response_type: req.query.response_type,
        client_id: req.query.client_id,
        redirect_uri: req.query.redirect_uri,
        state: req.query.state,
        code_challenge: req.query.code_challenge ? 'present' : 'missing',
        code_challenge_method: req.query.code_challenge_method
      }
    });

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
    checks.push({
      id: 'token-request',
      name: 'TokenRequest',
      description: 'Client requested access token',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'RFC-6749-4.1.3',
          url: 'https://tools.ietf.org/html/rfc6749#section-4.1.3'
        }
      ],
      details: {
        endpoint: '/token',
        grantType: req.body.grant_type
      }
    });

    res.json({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600
    });
  });

  app.post(authRoutes.registration_endpoint, (req: Request, res: Response) => {
    checks.push({
      id: 'client-registration',
      name: 'ClientRegistration',
      description: 'Client registered with authorization server',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'RFC-7591-2',
          url: 'https://tools.ietf.org/html/rfc7591#section-2'
        }
      ],
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
