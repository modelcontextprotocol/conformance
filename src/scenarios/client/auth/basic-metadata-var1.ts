import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';

export class AuthBasicMetadataVar1Scenario implements Scenario {
  // TODO: name should match what we put in the scenario map
  name = 'auth/basic-metadata-var1';
  description =
    'Tests Basic OAuth flow with DCR, PRM at root location, OAuth metadata at OpenID discovery path, and no scopes required';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      metadataPath: '/.well-known/openid-configuration',
      isOpenIdConfiguration: true
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        // TODO: this will put this path in the WWW-Authenticate header
        // but RFC 9728 states that in that case, the resource in the PRM
        // must match the URL used to make the request to the resource server.
        // We'll need to establish an opinion on whether that means the
        // URL for the metadata fetch, or the URL for the MCP endpoint,
        // or more generally what are the valid scenarios / combos.
        prmPath: '/.well-known/oauth-protected-resource'
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
