import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls, SpecVersion } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import express, { Request, Response } from 'express';
import { SpecReferences } from './spec-references';

export class Auth20250326OAuthMetadataBackcompatScenario implements Scenario {
  name = 'auth/2025-03-26-oauth-metadata-backcompat';
  specVersions: SpecVersion[] = ['2025-03-26'];
  description =
    'Tests 2025-03-26 spec OAuth flow: no PRM (Protected Resource Metadata), OAuth metadata at root location';
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    // Legacy server, so we create the auth server endpoints on the
    // same URL as the main server (rather than separating AS / RS).
    const authApp = createAuthServer(this.checks, this.server.getUrl, {
      // Disable logging since the main server will already have logging enabled
      loggingEnabled: false,
      // Add a prefix to auth endpoints to avoid being caught by auth fallbacks
      routePrefix: '/oauth'
    });
    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.server.getUrl,
      // Explicitly set to null to indicate no PRM available
      { prmPath: null }
    );
    app.use(authApp);

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'authorization-server-metadata',
      'client-registration',
      'authorization-request',
      'token-request'
    ];

    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name: `Expected Check Missing: ${slug}`,
          description: `Expected Check Missing: ${slug}`,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [SpecReferences.LEGACY_2025_03_26_AUTH_DISCOVERY]
        });
      }
    }

    return this.checks;
  }
}

export class Auth20250326OEndpointFallbackScenario implements Scenario {
  name = 'auth/2025-03-26-oauth-endpoint-fallback';
  specVersions: SpecVersion[] = ['2025-03-26'];
  description =
    'Tests OAuth flow with no metadata endpoints, relying on fallback to standard OAuth endpoints at server root (2025-03-26 spec behavior)';
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.server.getUrl,
      { prmPath: null }
    );

    // needed for /token endpoint
    app.use(express.urlencoded({ extended: true }));

    app.get('/authorize', (req: Request, res: Response) => {
      this.checks.push({
        id: 'authorization-request',
        name: 'AuthorizationRequest',
        description: 'Client made authorization request to fallback endpoint',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.LEGACY_2025_03_26_AUTH_URL_FALLBACK],
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

    app.post('/token', (req: Request, res: Response) => {
      this.checks.push({
        id: 'token-request',
        name: 'TokenRequest',
        description: 'Client requested access token from fallback endpoint',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.LEGACY_2025_03_26_AUTH_URL_FALLBACK],
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

    app.post('/register', (req: Request, res: Response) => {
      this.checks.push({
        id: 'client-registration',
        name: 'ClientRegistration',
        description:
          'Client registered with authorization server at fallback endpoint',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.LEGACY_2025_03_26_AUTH_URL_FALLBACK],
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

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'client-registration',
      'authorization-request',
      'token-request'
    ];

    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name: `Expected Check Missing: ${slug}`,
          description: `Expected Check Missing: ${slug}`,
          status: 'FAILURE',
          timestamp: new Date().toISOString()
        });
      }
    }

    return this.checks;
  }
}
