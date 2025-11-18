import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';

/**
 * Fixed client metadata URL that clients should use for CIMD tests.
 * This URL doesn't need to resolve - the server will accept it as-is
 * and use hardcoded metadata.
 */
export const CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

/**
 * Scenario: Client ID Metadata Documents (SEP-991/URL-based client IDs)
 *
 * Tests that when a server advertises client_id_metadata_document_supported=true,
 * clients SHOULD use a URL as their client_id instead of using dynamic client
 * registration.
 */
export class AuthBasicCIMDScenario implements Scenario {
  name = 'auth/basic-cimd';
  description =
    'Tests OAuth flow with Client ID Metadata Documents (SEP-991/URL-based client IDs). Server advertises client_id_metadata_document_supported=true and client should use URL as client_id instead of DCR.';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      clientIdMetadataDocumentSupported: true,
      onAuthorizationRequest: (data) => {
        // Check if client used URL-based client ID
        const usedUrlClientId = data.clientId === CIMD_CLIENT_METADATA_URL;
        this.checks.push({
          id: 'cimd-client-id-used',
          name: 'Client ID Metadata Document Usage',
          description: usedUrlClientId
            ? 'Client correctly used URL-based client ID when server supports client_id_metadata_document_supported'
            : 'Client SHOULD use URL-based client ID when server advertises client_id_metadata_document_supported=true',
          status: usedUrlClientId ? 'SUCCESS' : 'WARNING',
          timestamp: data.timestamp,
          specReferences: [
            SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS,
            SpecReferences.IETF_CIMD
          ],
          details: {
            expectedClientId: CIMD_CLIENT_METADATA_URL,
            actualClientId: data.clientId || 'none'
          }
        });
      }
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl
    );

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the CIMD check - if not, the client didn't make an auth request
    const hasCimdCheck = this.checks.some(
      (c) => c.id === 'cimd-client-id-used'
    );
    if (!hasCimdCheck) {
      this.checks.push({
        id: 'cimd-client-id-used',
        name: 'Client ID Metadata Document Usage',
        description:
          'Client did not make an authorization request to test CIMD support',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS,
          SpecReferences.IETF_CIMD
        ]
      });
    }

    return this.checks;
  }
}
