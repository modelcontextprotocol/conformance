import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import express from 'express';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';

export class AuthBasicDCRScenario implements Scenario {
  name = 'auth-basic-dcr';
  description =
    'Tests Basic OAuth flow with DCR, PRM at path-based location, OAuth metadata at root location, and no scopes required';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private authApp: express.Application | null = null;
  private authHttpServer: any = null;
  private checks: ConformanceCheck[] = [];
  private baseUrl: string = '';
  private authBaseUrl: string = '';

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    this.authApp = createAuthServer(this.checks, () => this.authBaseUrl);
    this.authHttpServer = this.authApp.listen(0);
    const authPort = this.authHttpServer.address().port;
    this.authBaseUrl = `http://localhost:${authPort}`;

    this.app = createServer(
      this.checks,
      () => this.baseUrl,
      () => this.authBaseUrl
    );
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    this.baseUrl = `http://localhost:${port}`;

    return { serverUrl: `${this.baseUrl}/mcp` };
  }

  async stop() {
    if (this.authHttpServer) {
      await new Promise<void>((resolve) => {
        this.authHttpServer.closeAllConnections?.();
        this.authHttpServer.close(() => resolve());
      });
      this.authHttpServer = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.closeAllConnections?.();
        this.httpServer.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.authApp = null;
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'prm-pathbased-requested',
      'authorization-server-metadata',
      'client-registration',
      'authorization-request',
      'token-request'
    ];

    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name:
            slug === 'prm-pathbased-requested'
              ? 'PRMPathBasedRequested'
              : 'PRMRootNotCheckedFirst',
          description:
            slug === 'prm-pathbased-requested'
              ? 'Client should request PRM metadata at path-based location'
              : 'Client should check path-based location before root',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          details: { message: 'Expected check not found' },
          specReferences: [
            {
              id: 'RFC-9728-3',
              url: 'https://tools.ietf.org/html/rfc9728#section-3'
            }
          ]
        });
      }
    }

    return this.checks;
  }
}
