import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';

export class AuthBasicMetadataVar1Scenario implements Scenario {
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

export class AuthBasicMetadataVar2Scenario implements Scenario {
  name = 'auth/basic-metadata-var2';
  description =
    'Tests Basic OAuth flow with DCR, PRM at root location, OAuth metadata at path-based OAuth discovery path';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      metadataPath: '/tenant1/.well-known/openid-configuration',
      isOpenIdConfiguration: true,
      routePrefix: '/tenant1'
    });

    authApp.get('/.well-known/oauth-authorization-server', (req, res) => {
      this.checks.push({
        id: 'authorization-server-metadata-wrong-path',
        name: 'AuthorizationServerMetadataWrongPath',
        description:
          'Client requested authorization server at the root path when the AS URL has a path-based location',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'RFC-8414',
            url: 'https://tools.ietf.org/html/rfc8414'
          }
        ],
        details: {
          url: req.url
        }
      });
      res.status(404).send('Not Found');
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      () => `${this.authServer.getUrl()}/tenant1`,
      {
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

export class AuthBasicMetadataVar3Scenario implements Scenario {
  name = 'auth/basic-metadata-var3';
  description =
    'Tests Basic OAuth flow with DCR, PRM at custom location listed in WWW-Authenticate header, OAuth metadata is at nested OpenID discovery path, and no scopes required';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      metadataPath: '/tenant1/.well-known/openid-configuration',
      isOpenIdConfiguration: true,
      routePrefix: '/tenant1'
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        // This is a custom path, so unable to get via probing, it's only available
        // via following the `resource_metadata_url` in the WWW-Authenticate header.
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
