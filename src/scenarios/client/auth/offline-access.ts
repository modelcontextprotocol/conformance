import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls, SpecVersion } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';

/**
 * Scenario: Offline Access Scope (SEP-2207)
 *
 * Tests client behavior when the Authorization Server metadata lists
 * `offline_access` in `scopes_supported`:
 *
 * 1. Client SHOULD include `refresh_token` in `grant_types` client metadata
 *    (checked via DCR body or CIMD document, whichever the client uses)
 * 2. Client MAY include `offline_access` in authorization request scope
 *
 * Setup:
 * - AS metadata: scopes_supported includes 'offline_access'
 * - PRM: scopes_supported does NOT include 'offline_access' (per SEP-2207 server guidance)
 * - Both CIMD and DCR paths available
 */
export class OfflineAccessScopeScenario implements Scenario {
  name = 'auth/offline-access-scope';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client handles offline_access scope and refresh_token grant type when AS supports them (SEP-2207)';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private grantTypesChecked = false;
  private capturedCimdUrl: string | undefined;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.grantTypesChecked = false;
    this.capturedCimdUrl = undefined;

    const tokenVerifier = new MockTokenVerifier(this.checks, ['mcp:basic']);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      scopesSupported: ['mcp:basic', 'offline_access'],
      clientIdMetadataDocumentSupported: true,
      onRegistrationRequest: (req) => {
        // DCR path: inspect grant_types in registration body
        const grantTypes: string[] = req.body.grant_types || [];
        const hasRefreshToken = grantTypes.includes('refresh_token');
        this.grantTypesChecked = true;
        this.checks.push({
          id: 'sep-2207-client-metadata-grant-types',
          name: 'Client metadata includes refresh_token grant type (DCR)',
          description: hasRefreshToken
            ? 'Client correctly included refresh_token in grant_types during dynamic client registration'
            : 'Client SHOULD include refresh_token in grant_types client metadata (SEP-2207)',
          status: hasRefreshToken ? 'SUCCESS' : 'WARNING',
          timestamp: new Date().toISOString(),
          specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
          details: {
            registrationMethod: 'DCR',
            grantTypes: grantTypes.length > 0 ? grantTypes.join(' ') : 'none'
          }
        });

        const clientId = `test-client-${Date.now()}`;
        return {
          clientId,
          clientSecret: undefined,
          tokenEndpointAuthMethod: 'none'
        };
      },
      onAuthorizationRequest: (data) => {
        // Capture CIMD URL if client used URL-based client_id
        if (data.clientId && data.clientId.startsWith('http')) {
          this.capturedCimdUrl = data.clientId;
        }

        // Check if client included offline_access in scope
        const requestedScopes = data.scope ? data.scope.split(' ') : [];
        const hasOfflineAccess = requestedScopes.includes('offline_access');
        this.checks.push({
          id: 'sep-2207-offline-access-requested',
          name: 'Client requests offline_access scope',
          description: hasOfflineAccess
            ? 'Client included offline_access in authorization request scope when AS lists it in scopes_supported'
            : 'Client MAY include offline_access in scope when AS metadata lists it in scopes_supported (SEP-2207). Client chose not to request it.',
          status: hasOfflineAccess ? 'SUCCESS' : 'INFO',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
          details: {
            asScopesSupported: 'mcp:basic offline_access',
            requestedScope: data.scope || 'none'
          }
        });
      }
    });
    await this.authServer.start(authApp);

    // PRM does NOT include offline_access (per SEP-2207 server guidance:
    // servers SHOULD NOT include offline_access in PRM scopes_supported)
    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: ['mcp:basic'],
        scopesSupported: ['mcp:basic'],
        tokenVerifier
      }
    );
    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    // If client used CIMD and we haven't checked grant_types yet,
    // attempt to fetch the CIMD URL to inspect the metadata document
    if (this.capturedCimdUrl && !this.grantTypesChecked) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(this.capturedCimdUrl, {
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.ok) {
          const metadata = await response.json();
          const grantTypes: string[] = metadata.grant_types || [];
          const hasRefreshToken = grantTypes.includes('refresh_token');
          this.grantTypesChecked = true;
          this.checks.push({
            id: 'sep-2207-client-metadata-grant-types',
            name: 'Client metadata includes refresh_token grant type (CIMD)',
            description: hasRefreshToken
              ? 'Client metadata document includes refresh_token in grant_types'
              : 'Client SHOULD include refresh_token in grant_types client metadata (SEP-2207)',
            status: hasRefreshToken ? 'SUCCESS' : 'WARNING',
            timestamp: new Date().toISOString(),
            specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
            details: {
              registrationMethod: 'CIMD',
              cimdUrl: this.capturedCimdUrl,
              grantTypes: grantTypes.length > 0 ? grantTypes.join(' ') : 'none'
            }
          });
        }
      } catch {
        // CIMD URL didn't resolve - emit info check
        this.grantTypesChecked = true;
        this.checks.push({
          id: 'sep-2207-client-metadata-grant-types',
          name: 'Client metadata includes refresh_token grant type (CIMD)',
          description:
            'Client used CIMD but metadata URL could not be fetched to verify grant_types',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
          details: {
            registrationMethod: 'CIMD',
            cimdUrl: this.capturedCimdUrl,
            fetchFailed: true
          }
        });
      }
    }

    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    const timestamp = new Date().toISOString();

    // If grant_types was never checked (no DCR, no CIMD, possibly pre-registered)
    if (!this.grantTypesChecked) {
      this.checks.push({
        id: 'sep-2207-client-metadata-grant-types',
        name: 'Client metadata includes refresh_token grant type',
        description:
          'Client did not use DCR or fetchable CIMD — grant_types could not be inspected',
        status: 'INFO',
        timestamp,
        specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
        details: {
          registrationMethod: 'unknown'
        }
      });
    }

    // If offline_access check never ran, the authorization flow didn't complete
    if (
      !this.checks.some((c) => c.id === 'sep-2207-offline-access-requested')
    ) {
      this.checks.push({
        id: 'sep-2207-offline-access-requested',
        name: 'Client requests offline_access scope',
        description:
          'Client did not complete authorization flow — offline_access scope check could not be performed',
        status: 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE]
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: Offline Access Not Supported (SEP-2207)
 *
 * Tests that clients do NOT include `offline_access` in the authorization
 * request scope when the AS metadata does NOT list it in `scopes_supported`.
 *
 * Per SEP-2207, clients MAY add offline_access only "when the Authorization
 * Server's metadata lists it in scopes_supported". If the AS doesn't support
 * it, requesting it is an error (requesting an unsupported scope).
 *
 * Setup:
 * - AS metadata: scopes_supported does NOT include 'offline_access'
 * - PRM: standard scopes
 */
export class OfflineAccessNotSupportedScenario implements Scenario {
  name = 'auth/offline-access-not-supported';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client does not request offline_access when AS does not list it in scopes_supported (SEP-2207)';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, [
      'mcp:basic',
      'mcp:read'
    ]);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      scopesSupported: ['mcp:basic', 'mcp:read'],
      onAuthorizationRequest: (data) => {
        const requestedScopes = data.scope ? data.scope.split(' ') : [];
        const hasOfflineAccess = requestedScopes.includes('offline_access');
        this.checks.push({
          id: 'sep-2207-offline-access-not-requested',
          name: 'Client does not request unsupported offline_access',
          description: hasOfflineAccess
            ? 'Client MUST NOT request offline_access when it is not listed in AS scopes_supported (SEP-2207)'
            : 'Client correctly did not request offline_access when AS does not list it in scopes_supported',
          status: hasOfflineAccess ? 'FAILURE' : 'SUCCESS',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE],
          details: {
            asScopesSupported: 'mcp:basic mcp:read',
            requestedScope: data.scope || 'none'
          }
        });
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: ['mcp:basic', 'mcp:read'],
        scopesSupported: ['mcp:basic', 'mcp:read'],
        tokenVerifier
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
    if (
      !this.checks.some((c) => c.id === 'sep-2207-offline-access-not-requested')
    ) {
      this.checks.push({
        id: 'sep-2207-offline-access-not-requested',
        name: 'Client does not request unsupported offline_access',
        description:
          'Client did not complete authorization flow — offline_access scope check could not be performed',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.SEP_2207_REFRESH_TOKEN_GUIDANCE]
      });
    }

    return this.checks;
  }
}
