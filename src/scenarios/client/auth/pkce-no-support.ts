/**
 * PKCE No S256 Support Scenario
 *
 * Tests that clients correctly refuse to proceed when the authorization server
 * advertises PKCE support but does NOT include S256 in the supported methods.
 *
 * Per MCP spec: "MCP clients MUST use the S256 code challenge method when
 * technically capable" - if the server doesn't support S256, client must refuse.
 *
 * Note: code_challenge_methods_supported being absent is acceptable (server
 * just doesn't advertise). But if present and empty or missing S256, client
 * must refuse.
 */

import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';

export class PkceNoS256SupportScenario implements Scenario {
  name = 'auth/pkce-no-s256-support';
  description =
    'Tests that client refuses to proceed when authorization server does not support S256 (code_challenge_methods_supported is empty or missing S256)';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequested = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequested = false;

    // Create auth server with PKCE methods that don't include S256
    // (e.g., empty array or only 'plain' which is insecure)
    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      codeChallengeMethodsSupported: [], // Empty = no methods supported
      // Override the authorization endpoint to detect if client proceeds
      onAuthorizationRequest: () => {
        this.authorizationRequested = true;
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
    // Add the PKCE S256 refused check based on whether authorization was requested
    this.checks.push({
      id: 'pkce-s256-required',
      name: 'PKCE S256 Required',
      description: this.authorizationRequested
        ? 'Client proceeded with authorization despite S256 not being supported - clients MUST refuse when S256 is not available'
        : 'Client correctly refused to proceed when S256 was not in code_challenge_methods_supported',
      status: this.authorizationRequested ? 'FAILURE' : 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.MCP_PKCE],
      details: {
        authorizationRequested: this.authorizationRequested,
        codeChallengeMethodsSupported: []
      }
    });

    return this.checks;
  }
}
