import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
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
export class ResourceMismatchScenario extends AuthHandlerScenario {
  name = 'auth/resource-mismatch';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client rejects when PRM resource does not match server URL';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    // An authorization request means the client proceeded despite the
    // mismatch; getChecks() reads it from the log.
    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      tokenEndpointAuthMethodsSupported: ['none'],
      onRegistrationRequest: () => ({
        clientId: `test-client-${Date.now()}`,
        clientSecret: undefined,
        tokenEndpointAuthMethod: 'none'
      })
    });

    // Create server that returns a mismatched resource in PRM
    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [],
      tokenVerifier,
      // Return a different origin in PRM - this should be rejected by the client
      prmResourceOverride: 'https://evil.example.com/mcp'
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
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
    if (!checks.some((c) => c.id === 'resource-mismatch-rejected')) {
      const prmRequested = this.checks.some(
        (c) => c.id === 'prm-pathbased-requested'
      );
      const authorizationRequestMade = this.checks.some(
        (c) => c.id === 'authorization-request'
      );
      const correctlyRejected = prmRequested && !authorizationRequestMade;
      const observations = {
        prmResource: 'https://evil.example.com/mcp',
        expectedBehavior: 'Client should NOT proceed with authorization',
        prmRequested,
        authorizationRequestMade
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
        checks.push(check);
      } else {
        checks.push({
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

    return checks;
  }
}
