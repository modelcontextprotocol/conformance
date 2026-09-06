import type { ScenarioContext } from '../../../mock-server';
import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls, DRAFT_PROTOCOL_VERSION } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import { untestableCheck } from '../../untestable.js';

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
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client rejects when PRM resource does not match server URL';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequestMade = false;

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, this.authServer.getUrl, {
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
      ctx,
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

    // Reason-bound verdict (#467). "Did not proceed with authorization" is not
    // by itself evidence of validation: a client that never fetched the PRM
    // document never read the mismatched `resource`, so it cannot have
    // compared it. Absent that fetch the requirement was never exercised,
    // which is the untestable case (#248) rather than a pass or a violation.
    if (!this.checks.some((c) => c.id === 'resource-mismatch-rejected')) {
      const prmRequested = this.checks.some(
        (c) => c.id === 'prm-pathbased-requested'
      );
      const correctlyRejected = prmRequested && !this.authorizationRequestMade;
      const observations = {
        prmResource: 'https://evil.example.com/mcp',
        expectedBehavior: 'Client should NOT proceed with authorization',
        prmRequested,
        authorizationRequestMade: this.authorizationRequestMade
      };

      if (!prmRequested) {
        const check = untestableCheck(
          'resource-mismatch-rejected',
          'Client rejects mismatched resource',
          'Client MUST validate that PRM resource matches the server URL before proceeding with authorization',
          'client never requested the Protected Resource Metadata document, so it never read the resource value it was required to validate',
          specRefs
        );
        check.details = {
          ...check.details,
          ...observations,
          propertyReached: false,
          stopReason: 'prm-not-requested'
        };
        this.checks.push(check);
      } else {
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
            ...observations,
            propertyReached: true,
            stopReason: correctlyRejected
              ? 'declined-after-reading-prm'
              : 'proceeded-to-authorization'
          }
        });
      }
    }

    return this.checks;
  }
}
