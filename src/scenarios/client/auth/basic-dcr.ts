import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';

export class AuthBasicDCRScenario implements Scenario {
  name = 'auth-basic-dcr';
  description =
    'Tests Basic OAuth flow with DCR, PRM at path-based location, OAuth metadata at root location, and no scopes required';
  private authServer = new ServerLifecycle(() => this.authBaseUrl);
  private server = new ServerLifecycle(() => this.baseUrl);
  private checks: ConformanceCheck[] = [];
  private baseUrl: string = '';
  private authBaseUrl: string = '';

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, () => this.authBaseUrl);
    this.authBaseUrl = await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      () => this.baseUrl,
      () => this.authBaseUrl
    );
    this.baseUrl = await this.server.start(app);

    return { serverUrl: `${this.baseUrl}/mcp` };
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
