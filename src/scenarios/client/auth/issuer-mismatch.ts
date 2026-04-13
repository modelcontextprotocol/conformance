import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls, SpecVersion } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';

/**
 * Scenario: Authorization Server Issuer Mismatch Detection
 *
 * Tests that clients correctly detect and reject when the Authorization
 * Server metadata response contains an `issuer` value that doesn't match
 * the issuer identifier used to construct the metadata URL.
 *
 * Per RFC 8414 §3.3, clients MUST validate that the issuer in the metadata
 * response matches the issuer used to construct the well-known metadata URL.
 * Failing to do so enables mix-up attacks where a malicious AS impersonates
 * another.
 *
 * Setup:
 * - PRM advertises authorization server at http://localhost:<port> (root issuer)
 * - Client constructs metadata URL /.well-known/oauth-authorization-server
 * - AS responds with issuer: "https://evil.example.com" (mismatch)
 *
 * Expected behavior:
 * - Client should NOT proceed with authorization
 * - Client should abort due to issuer mismatch
 * - Test passes if client does NOT make an authorization request
 */
export class IssuerMismatchScenario implements Scenario {
  name = 'auth/issuer-mismatch';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client rejects when AS metadata issuer does not match the issuer used to construct the metadata URL (RFC 8414 §3.3)';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequestMade = false;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      // Root issuer: metadata at /.well-known/oauth-authorization-server,
      // so the expected issuer is just the base URL. Override it to a
      // different origin to trigger the mismatch.
      issuerOverride: 'https://evil.example.com',
      onAuthorizationRequest: () => {
        // If we get here, the client incorrectly proceeded past issuer validation
        this.authorizationRequestMade = true;
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp'
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

    if (!this.checks.some((c) => c.id === 'issuer-mismatch-rejected')) {
      const correctlyRejected = !this.authorizationRequestMade;
      this.checks.push({
        id: 'issuer-mismatch-rejected',
        name: 'Client rejects mismatched issuer',
        description: correctlyRejected
          ? 'Client correctly rejected authorization when AS metadata issuer does not match the metadata URL'
          : 'Client MUST validate that the issuer in AS metadata matches the issuer used to construct the metadata URL (RFC 8414 §3.3)',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.RFC_AUTH_SERVER_METADATA_VALIDATION],
        details: {
          metadataIssuer: 'https://evil.example.com',
          expectedIssuer: this.authServer.getUrl(),
          expectedBehavior: 'Client should NOT proceed with authorization',
          authorizationRequestMade: this.authorizationRequestMade
        }
      });
    }

    return this.checks;
  }
}
