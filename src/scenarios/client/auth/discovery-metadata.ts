/**
 * OAuth Metadata Discovery Scenarios
 *
 * These scenarios test different combinations of PRM and OAuth metadata locations.
 * The configurations are defined in SCENARIO_CONFIGS below and scenarios are
 * generated from them.
 */

import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { SpecReferences } from './spec-references';
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
 * Base for the table-driven discovery scenarios. Each subclass binds a row
 * of SCENARIO_CONFIGS; we use real classes (not factory-returned literals)
 * so the hosted runner can do `new Ctor()` for a fresh instance per run.
 */
abstract class MetadataDiscoveryScenario extends AuthHandlerScenario {
  protected abstract readonly config: MetadataScenarioConfig;
  readonly source = { introducedIn: '2025-11-25' } as const;
  private checks: ConformanceCheck[] = [];

  get name() {
    return `auth/${this.config.name}`;
  }
  get description() {
    return `Tests Basic OAuth metadata discovery flow.

**PRM:** ${this.config.prmLocation}${this.config.inWwwAuth ? '' : ' (not in WWW-Authenticate)'}
**OAuth metadata:** ${this.config.oauthMetadataLocation}
`;
  }

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const config = this.config;
    const routePrefix = config.authRoutePrefix || '';
    const isOpenIdConfiguration = config.oauthMetadataLocation.includes(
      'openid-configuration'
    );
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const authApp = createAuthServer(this.checks, getAsUrl, {
      metadataPath: config.oauthMetadataLocation,
      isOpenIdConfiguration,
      ...(routePrefix && { routePrefix })
    });

    // If path-based OAuth metadata, trap root requests
    if (routePrefix) {
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
    }

    const getAuthServerUrl = routePrefix
      ? () => `${getAsUrl()}${routePrefix}`
      : getAsUrl;

    const rsApp = createServer(
      this.checks,
      ctx.getRsBaseUrl,
      getAuthServerUrl,
      {
        prmPath: config.prmLocation,
        includePrmInWwwAuth: config.inWwwAuth
      }
    );

    // Add trap for root PRM requests if configured
    if (config.trapRootPrm) {
      rsApp.get(
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

          res.status(404).json({
            error: 'not_found',
            error_description: 'PRM metadata not available at root location'
          });
        }
      );
    }

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const isPathBasedPrm =
      this.config.prmLocation === '/.well-known/oauth-protected-resource/mcp';
    const expectedSlugs = [
      ...(isPathBasedPrm ? ['prm-pathbased-requested'] : []),
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

export class AuthMetadataDefaultScenario extends MetadataDiscoveryScenario {
  protected readonly config = SCENARIO_CONFIGS[0];
}
export class AuthMetadataVar1Scenario extends MetadataDiscoveryScenario {
  protected readonly config = SCENARIO_CONFIGS[1];
}
export class AuthMetadataVar2Scenario extends MetadataDiscoveryScenario {
  protected readonly config = SCENARIO_CONFIGS[2];
}
export class AuthMetadataVar3Scenario extends MetadataDiscoveryScenario {
  protected readonly config = SCENARIO_CONFIGS[3];
}

// Export all scenarios as an array for convenience
export const metadataScenarios = [
  new AuthMetadataDefaultScenario(),
  new AuthMetadataVar1Scenario(),
  new AuthMetadataVar2Scenario(),
  new AuthMetadataVar3Scenario()
];

// Export function to list metadata scenario names (for suite support)
export function listMetadataScenarios(): string[] {
  return metadataScenarios.map((s) => s.name);
}
