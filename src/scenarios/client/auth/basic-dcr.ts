import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { Request, Response } from 'express';
import { SpecReferences } from './spec-references.js';

export class AuthBasicDCRScenario implements Scenario {
  name = 'auth/basic-dcr';
  description =
    'Tests Basic OAuth flow with DCR, PRM at path-based location, OAuth metadata at root location, and no scopes required';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl);
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl
    );

    // For this scenario, reject PRM requests at root location since we have the path-based PRM.
    app.get(
      '/.well-known/oauth-protected-resource',
      (req: Request, res: Response) => {
        this.checks.push({
          id: 'prm-priority-order',
          name: 'PRM Priority Order',
          description:
            'Client requested PRM metadata at root location on a server with path-based PRM',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [
            SpecReferences.RFC_PRM_DISCOVERY,
            SpecReferences.MCP_PRM_DISCOVERY
          ],
          details: {
            url: req.url,
            path: req.path
          }
        });

        // Return 404 to indicate PRM is not available at root location
        res.status(404).json({
          error: 'not_found',
          error_description: 'PRM metadata not available at root location'
        });
      }
    );

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
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
          // TODO: these are redundant...
          name: `Expected Check Missing: ${slug}`,
          description: `Expected Check Missing: ${slug}`,
          status: 'FAILURE',
          timestamp: new Date().toISOString()
          // TODO: ideally we'd add the spec references
        });
      }
    }

    return this.checks;
  }
}
