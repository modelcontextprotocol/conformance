import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { Request, Response } from 'express';

export class AuthMarchSpecBackcompatScenario implements Scenario {
  name = 'auth/march-spec-backcompat';
  description =
    'Tests March 2024 spec OAuth flow: no PRM (Protected Resource Metadata), OAuth metadata at root location';
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    // Legacy server, so we create the auth server endpoints on the
    // same URL as the main server (rather than separating AS / RS).
    const authApp = createAuthServer(this.checks, this.server.getUrl, {
      // Disable logging since the main server will already have logging enabled
      loggingEnabled: false
    });
    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.server.getUrl,
      // Explicitly set to null to indicate no PRM available
      { prmPath: null }
    );
    app.use(authApp);

    app.get(
      '/.well-known/oauth-protected-resource',
      (req: Request, res: Response) => {
        this.checks.push({
          id: 'no-prm-root',
          name: 'No PRM at Root',
          description:
            'Client attempted to fetch PRM at root location, but March spec does not have PRM',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          details: {
            url: req.url,
            path: req.path,
            note: 'March spec behavior: no PRM available'
          }
        });

        res.status(404).json({
          error: 'not_found',
          error_description: 'PRM not available (March spec behavior)'
        });
      }
    );

    app.get(
      '/.well-known/oauth-protected-resource/mcp',
      (req: Request, res: Response) => {
        this.checks.push({
          id: 'no-prm-path',
          name: 'No PRM at Path',
          description:
            'Client attempted to fetch PRM at path-based location, but March spec behavior does not have PRM',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          details: {
            url: req.url,
            path: req.path,
            note: 'March spec behavior: no PRM available'
          }
        });

        res.status(404).json({
          error: 'not_found',
          error_description: 'PRM not available (March spec behavior)'
        });
      }
    );

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
          timestamp: new Date().toISOString()
        });
      }
    }

    return this.checks;
  }
}
