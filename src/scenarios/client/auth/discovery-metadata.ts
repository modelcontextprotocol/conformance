/**
 * OAuth Metadata Discovery Scenarios
 *
 * These scenarios test different combinations of PRM and OAuth metadata locations.
 * The configurations are defined in SCENARIO_CONFIGS below and scenarios are
 * generated from them.
 */

import type { ScenarioContext } from '../../../mock-server';
import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import { untestableCheck } from '../../untestable';
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
  /**
   * Query string (without '?') appended to the MCP server URL handed to the
   * client. The client must preserve it when constructing the PRM well-known
   * URL (RFC 9728 §3.1).
   */
  serverUrlQuery?: string;
}

/**
 * Scenario configurations table:
 *
 * | Scenario              | PRM Location                              | In WWW-Auth | OAuth Metadata Location                        |
 * |-----------------------|-------------------------------------------|-------------|------------------------------------------------|
 * | metadata-default      | /.well-known/oauth-protected-resource/mcp | Yes         | /.well-known/oauth-authorization-server        |
 * | metadata-var1         | /.well-known/oauth-protected-resource/mcp | No          | /.well-known/openid-configuration              |
 * | metadata-var2         | /.well-known/oauth-protected-resource     | No          | /.well-known/oauth-authorization-server/tenant1|
 * | metadata-var3         | /custom/metadata/location.json            | Yes         | /tenant1/.well-known/openid-configuration      |
 * | metadata-query-params | /.well-known/oauth-protected-resource/mcp | No          | /.well-known/oauth-authorization-server        |
 *
 * metadata-query-params uses var1's PRM placement (path-based, not advertised
 * in WWW-Authenticate) with the default OAuth metadata location, and hands
 * the client an MCP server URL with a query component. Per RFC 9728 §3.1 the
 * well-known suffix is inserted between the host and the path and/or query
 * components, so the client's PRM request must keep the query:
 * /.well-known/oauth-protected-resource/mcp?tenant=alpha. This is a separate
 * scenario rather than a tweak to an existing config because a query-bearing
 * resource identifier is itself a SHOULD NOT-discouraged configuration
 * (RFC 9728 §1.2), so it must not contaminate the mainline metadata
 * scenarios' server URL (the mutually-exclusive-config carve-out in
 * AGENTS.md).
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
  },
  {
    name: 'metadata-query-params',
    prmLocation: '/.well-known/oauth-protected-resource/mcp',
    inWwwAuth: false,
    oauthMetadataLocation: '/.well-known/oauth-authorization-server',
    serverUrlQuery: 'tenant=alpha'
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
    source: { introducedIn: '2025-11-25' },
    description: `Tests Basic OAuth metadata discovery flow.

**PRM:** ${config.prmLocation}${config.inWwwAuth ? '' : ' (not in WWW-Authenticate)'}
**OAuth metadata:** ${config.oauthMetadataLocation}
${config.serverUrlQuery ? `**Server URL query:** ?${config.serverUrlQuery} (client should preserve it in the PRM well-known URL per RFC 9728 §3.1)\n` : ''}`,

    async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
      checks = [];

      const authApp = createAuthServer(ctx, checks, authServer.getUrl, {
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

      const app = createServer(ctx, checks, server.getUrl, getAuthServerUrl, {
        prmPath: config.prmLocation,
        includePrmInWwwAuth: config.inWwwAuth,
        ...(config.serverUrlQuery && {
          expectedPrmQuery: config.serverUrlQuery
        })
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

      return {
        serverUrl: `${server.getUrl()}/mcp${config.serverUrlQuery ? `?${config.serverUrlQuery}` : ''}`
      };
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

      // If the client never reached the PRM well-known URL at all, query
      // preservation could not be observed. Report the check as untestable at
      // the requirement's severity (WARNING — see createServer) rather than
      // letting it silently disappear.
      if (
        config.serverUrlQuery &&
        !checks.find((c) => c.id === 'prm-query-preserved')
      ) {
        checks.push(
          untestableCheck(
            'prm-query-preserved',
            'PRMQueryPreserved',
            'Client is expected to preserve the MCP server URL query component when constructing the PRM well-known URL (RFC 9728 §3.1)',
            'client never requested the path-based PRM well-known URL, so query preservation could not be verified',
            [
              SpecReferences.RFC_PRM_DISCOVERY,
              SpecReferences.MCP_PRM_DISCOVERY
            ],
            'WARNING'
          )
        );
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
export const AuthMetadataQueryParamsScenario = createMetadataScenario(
  SCENARIO_CONFIGS[4]
);

// Export all scenarios as an array for convenience
export const metadataScenarios = SCENARIO_CONFIGS.map(createMetadataScenario);

// Export function to list metadata scenario names (for suite support)
export function listMetadataScenarios(): string[] {
  return metadataScenarios.map((s) => s.name);
}
