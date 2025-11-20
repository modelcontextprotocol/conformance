/**
 * OAuth Metadata Discovery Scenarios
 *
 * These scenarios test different combinations of PRM and OAuth metadata locations.
 * The configurations are defined in SCENARIO_CONFIGS below and scenarios are
 * generated from them.
 */

import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { Request, Response } from 'express';

/**
 * Configuration for a metadata discovery scenario.
 */
interface MetadataScenarioConfig {
  name: string;
  prmLocation: string;
  inWwwAuth: boolean;
  oauthMetadataLocation: string;
  /** Route prefix for the auth server (e.g., '/tenant1') */
  authRoutePrefix?: string;
  /** If true, add a trap for root PRM requests */
  trapRootPrm?: boolean;
}

/**
 * Scenario configurations table:
 *
 * | Scenario         | PRM Location                              | In WWW-Auth | OAuth Metadata Location                        |
 * |------------------|-------------------------------------------|-------------|------------------------------------------------|
 * | metadata-default | /.well-known/oauth-protected-resource/mcp | Yes         | /.well-known/oauth-authorization-server        |
 * | metadata-var1    | /.well-known/oauth-protected-resource/mcp | No          | /.well-known/openid-configuration              |
 * | metadata-var2    | /.well-known/oauth-protected-resource     | No          | /.well-known/oauth-authorization-server/tenant1|
 * | metadata-var3    | /custom/metadata/location.json            | Yes         | /tenant1/.well-known/openid-configuration      |
 */
const SCENARIO_CONFIGS: MetadataScenarioConfig[] = [
  {
    name: 'metadata-default',
    prmLocation: '/.well-known/oauth-protected-resource/mcp',
    inWwwAuth: true,
    oauthMetadataLocation: '/.well-known/oauth-authorization-server',
    trapRootPrm: true
  },
  {
    name: 'metadata-var1',
    prmLocation: '/.well-known/oauth-protected-resource/mcp',
    inWwwAuth: false,
    oauthMetadataLocation: '/.well-known/openid-configuration'
  },
  {
    name: 'metadata-var2',
    prmLocation: '/.well-known/oauth-protected-resource',
    inWwwAuth: false,
    oauthMetadataLocation: '/.well-known/oauth-authorization-server/tenant1',
    authRoutePrefix: '/tenant1'
  },
  {
    name: 'metadata-var3',
    prmLocation: '/custom/metadata/location.json',
    inWwwAuth: true,
    oauthMetadataLocation: '/tenant1/.well-known/openid-configuration',
    authRoutePrefix: '/tenant1'
  }
];

/**
 * Creates a metadata discovery scenario from configuration.
 */
function createMetadataScenario(config: MetadataScenarioConfig): Scenario {
  const authServer = new ServerLifecycle();
  const server = new ServerLifecycle();
  let checks: ConformanceCheck[] = [];

  const routePrefix = config.authRoutePrefix || '';
  const isOpenIdConfiguration = config.oauthMetadataLocation.includes(
    'openid-configuration'
  );

  // Determine if PRM is at path-based location
  const isPathBasedPrm =
    config.prmLocation === '/.well-known/oauth-protected-resource/mcp';

  return {
    name: `auth/${config.name}`,
    description: `Tests Basic OAuth metadata discovery flow.

**PRM:** ${config.prmLocation}${config.inWwwAuth ? '' : ' (not in WWW-Authenticate)'}
**OAuth metadata:** ${config.oauthMetadataLocation}
`,

    async start(): Promise<ScenarioUrls> {
      checks = [];

      const authApp = createAuthServer(checks, authServer.getUrl, {
        metadataPath: config.oauthMetadataLocation,
        isOpenIdConfiguration,
        ...(routePrefix && { routePrefix })
      });

      // If path-based OAuth metadata, trap root requests
      if (routePrefix) {
        authApp.get('/.well-known/oauth-authorization-server', (req, res) => {
          checks.push({
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
      }

      await authServer.start(authApp);

      const getAuthServerUrl = routePrefix
        ? () => `${authServer.getUrl()}${routePrefix}`
        : authServer.getUrl;

      const app = createServer(checks, server.getUrl, getAuthServerUrl, {
        prmPath: config.prmLocation,
        includePrmInWwwAuth: config.inWwwAuth
      });

      // Add trap for root PRM requests if configured
      if (config.trapRootPrm) {
        app.get(
          '/.well-known/oauth-protected-resource',
          (req: Request, res: Response) => {
            checks.push({
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

            res.status(404).json({
              error: 'not_found',
              error_description: 'PRM metadata not available at root location'
            });
          }
        );
      }

      await server.start(app);

      return { serverUrl: `${server.getUrl()}/mcp` };
    },

    async stop() {
      await authServer.stop();
      await server.stop();
    },

    getChecks(): ConformanceCheck[] {
      const expectedSlugs = [
        ...(isPathBasedPrm ? ['prm-pathbased-requested'] : []),
        'authorization-server-metadata',
        'client-registration',
        'authorization-request',
        'token-request'
      ];

      for (const slug of expectedSlugs) {
        if (!checks.find((c) => c.id === slug)) {
          checks.push({
            id: slug,
            name: `Expected Check Missing: ${slug}`,
            description: `Expected Check Missing: ${slug}`,
            status: 'FAILURE',
            timestamp: new Date().toISOString()
          });
        }
      }

      return checks;
    }
  };
}

// Generate scenario instances from configurations
export const AuthMetadataDefaultScenario = createMetadataScenario(
  SCENARIO_CONFIGS[0]
);
export const AuthMetadataVar1Scenario = createMetadataScenario(
  SCENARIO_CONFIGS[1]
);
export const AuthMetadataVar2Scenario = createMetadataScenario(
  SCENARIO_CONFIGS[2]
);
export const AuthMetadataVar3Scenario = createMetadataScenario(
  SCENARIO_CONFIGS[3]
);

// Export all scenarios as an array for convenience
export const metadataScenarios = SCENARIO_CONFIGS.map(createMetadataScenario);
