import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';

/**
 * Scenario: Resource Mismatch Detection
 *
 * Tests that clients correctly detect and reject when the Protected Resource
 * Metadata returns a `resource` field that doesn't match the server URL
 * the client is trying to access.
 *
 * Per RFC 8707 and MCP spec, clients MUST validate that the resource from
 * PRM matches the expected server before proceeding with authorization.
 *
 * Setup:
 * - Server returns PRM with resource: "https://evil.example.com/mcp" (different origin)
 * - Client is trying to access the actual server at localhost:<port>/mcp
 *
 * Expected behavior:
 * - Client should NOT proceed with authorization
 * - Client should abort due to resource mismatch
 * - Test passes if client does NOT complete the auth flow (no authorization request)
 */
export class ResourceMismatchScenario implements Scenario {
  name = 'auth/resource-mismatch';
  description =
    'Tests that client rejects when PRM resource does not match server URL';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      tokenEndpointAuthMethodsSupported: ['none'],
      onAuthorizationRequest: () => {
        // If we get here, the client incorrectly proceeded with auth
        this.authorizationRequestMade = true;
      },
      onRegistrationRequest: () => ({
        clientId: `test-client-${Date.now()}`,
        clientSecret: undefined,
        tokenEndpointAuthMethod: 'none'
      })
    });
    await this.authServer.start(authApp);

    // Create server that returns a mismatched resource in PRM
    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [],
        tokenVerifier,
        // Return a different origin in PRM - this should be rejected by the client
        prmResourceOverride: 'https://evil.example.com/mcp'
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
    const timestamp = new Date().toISOString();
    const specRefs = [
      SpecReferences.RFC_8707_RESOURCE_INDICATORS,
      SpecReferences.MCP_RESOURCE_PARAMETER
    ];

    // The test passes if the client did NOT make an authorization request
    // (meaning it correctly rejected the mismatched resource)
    if (!this.checks.some((c) => c.id === 'resource-mismatch-rejected')) {
      const correctlyRejected = !this.authorizationRequestMade;
      this.checks.push({
        id: 'resource-mismatch-rejected',
        name: 'Client rejects mismatched resource',
        description: correctlyRejected
          ? 'Client correctly rejected authorization when PRM resource does not match server URL'
          : 'Client MUST validate that PRM resource matches the server URL before proceeding with authorization',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          prmResource: 'https://evil.example.com/mcp',
          expectedBehavior: 'Client should NOT proceed with authorization',
          authorizationRequestMade: this.authorizationRequestMade
        }
      });
    }

    return this.checks;
  }
}
