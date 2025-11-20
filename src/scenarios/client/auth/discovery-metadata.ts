import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { Request, Response } from 'express';

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

export class AuthBasicMetadataVar1Scenario implements Scenario {
  name = 'auth/basic-metadata-var1';
  description = `
Tests Basic OAuth flow with:
Registration: via DCR
PRM: At the path-based location (not in WWW-authenticate)
OAuth metadata: at OpenID discovery path
`;
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
        prmPath: '/.well-known/oauth-protected-resource',
        includePrmInWwwAuth: false
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
          SpecReferences.RFC_AUTH_SERVER_METADATA_REQUEST,
          SpecReferences.MCP_AUTH_DISCOVERY
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
      () => {
        return `${this.authServer.getUrl()}/tenant1`;
      },
      {
        // This is a custom path, so unable to get via probing, it's only available
        // via following the `resource_metadata_url` in the WWW-Authenticate header.
        // The resource must match the original request URL per RFC 9728.
        prmPath: '/custom/metadata/location.json'
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
