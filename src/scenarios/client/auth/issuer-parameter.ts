import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls, SpecVersion } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';

const specRefs = [SpecReferences.RFC_9207_ISS_PARAMETER];

/**
 * Scenario: ISS Parameter Supported (positive)
 *
 * Server advertises authorization_response_iss_parameter_supported: true and
 * includes the correct iss value in the authorization redirect. A conformant
 * client should validate iss and proceed normally.
 */
export class IssParameterSupportedScenario implements Scenario {
  name = 'auth/iss-supported';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client accepts authorization response when server advertises and sends correct iss parameter';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'correct',
      onTokenRequest: () => {
        this.tokenRequestMade = true;
        return { token: `test-token-${Date.now()}`, scopes: [] };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { requiredScopes: [], tokenVerifier }
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

    this.checks.push({
      id: 'iss-client-accepted-supported',
      name: 'Client accepts matching iss when advertised',
      description: this.tokenRequestMade
        ? 'Client compared advertised iss against recorded issuer and proceeded to token exchange'
        : 'Client did not proceed to token exchange after receiving a correct iss from a server that advertised support',
      status: this.tokenRequestMade ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: { tokenRequestMade: this.tokenRequestMade }
    });

    return this.checks;
  }
}

/**
 * Scenario: ISS Parameter Not Advertised (positive)
 *
 * Server does not advertise authorization_response_iss_parameter_supported and
 * does not include iss in the redirect. A conformant client should proceed normally.
 */
export class IssParameterNotAdvertisedScenario implements Scenario {
  name = 'auth/iss-not-advertised';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client accepts authorization response when server does not advertise or send iss parameter';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: null,
      issInRedirect: 'omit',
      onTokenRequest: () => {
        this.tokenRequestMade = true;
        return { token: `test-token-${Date.now()}`, scopes: [] };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { requiredScopes: [], tokenVerifier }
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

    this.checks.push({
      id: 'iss-client-proceed-no-iss',
      name: 'Client proceeds when iss absent and not advertised',
      description: this.tokenRequestMade
        ? 'Client proceeded to token exchange when neither metadata advertised iss support nor redirect contained iss'
        : 'Client did not proceed to token exchange — should proceed when iss is absent and not advertised',
      status: this.tokenRequestMade ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: { tokenRequestMade: this.tokenRequestMade }
    });

    return this.checks;
  }
}

/**
 * Scenario: ISS Parameter Advertised but Missing from Redirect (client must reject)
 *
 * Server advertises authorization_response_iss_parameter_supported: true but
 * omits iss from the redirect. A conformant client MUST reject this response.
 */
export class IssParameterSupportedMissingScenario implements Scenario {
  name = 'auth/iss-supported-missing';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client rejects authorization response when server advertised iss support but omitted iss from redirect';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authReached = false;
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authReached = false;
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'omit', // advertise support but don't send iss
      onAuthorizationRequest: () => {
        this.authReached = true;
      },
      onTokenRequest: () => {
        this.tokenRequestMade = true;
        return { token: `test-token-${Date.now()}`, scopes: [] };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { requiredScopes: [], tokenVerifier }
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

    if (!this.checks.some((c) => c.id === 'iss-client-rejected-missing')) {
      const correctlyRejected = this.authReached && !this.tokenRequestMade;
      this.checks.push({
        id: 'iss-client-rejected-missing',
        name: 'Client rejects missing iss when required',
        description: correctlyRejected
          ? 'Client correctly rejected authorization response missing required iss parameter'
          : 'Client MUST reject authorization response when server advertised iss support but iss is absent from redirect',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          serverAdvertisedSupport: true,
          issSentInRedirect: false,
          authReached: this.authReached,
          tokenRequestMade: this.tokenRequestMade
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: ISS Parameter Has Wrong Value (client must reject)
 *
 * Server advertises authorization_response_iss_parameter_supported: true and
 * includes an iss value that does not match the server's actual issuer. A
 * conformant client MUST reject this response.
 */
export class IssParameterWrongIssuerScenario implements Scenario {
  name = 'auth/iss-wrong-issuer';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client rejects authorization response when iss does not match the authorization server issuer';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authReached = false;
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authReached = false;
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'wrong', // send iss that doesn't match metadata issuer
      onAuthorizationRequest: () => {
        this.authReached = true;
      },
      onTokenRequest: () => {
        this.tokenRequestMade = true;
        return { token: `test-token-${Date.now()}`, scopes: [] };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { requiredScopes: [], tokenVerifier }
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

    if (!this.checks.some((c) => c.id === 'iss-client-rejected-wrong-issuer')) {
      const correctlyRejected = this.authReached && !this.tokenRequestMade;
      this.checks.push({
        id: 'iss-client-rejected-wrong-issuer',
        name: 'Client rejects mismatched iss',
        description: correctlyRejected
          ? 'Client correctly rejected authorization response with mismatched iss parameter'
          : 'Client MUST reject authorization response when iss does not match the authorization server issuer',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          serverAdvertisedSupport: true,
          issSentInRedirect: 'https://evil.example.com',
          authReached: this.authReached,
          tokenRequestMade: this.tokenRequestMade
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: ISS Parameter Sent but Not Advertised, Mismatched (client must reject)
 *
 * Server does not advertise authorization_response_iss_parameter_supported but
 * includes a mismatched iss value in the redirect. Per the SEP-2468 spec table
 * row 3, a conformant client MUST compare a present iss against the recorded
 * issuer regardless of metadata advertisement, and reject on mismatch.
 */
export class IssParameterUnexpectedScenario implements Scenario {
  name = 'auth/iss-unexpected';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client compares iss against recorded issuer even when not advertised, and rejects on mismatch';
  allowClientError = true;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authReached = false;
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authReached = false;
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: null,
      issInRedirect: 'wrong', // send mismatched iss without advertising support
      onAuthorizationRequest: () => {
        this.authReached = true;
      },
      onTokenRequest: () => {
        this.tokenRequestMade = true;
        return { token: `test-token-${Date.now()}`, scopes: [] };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { requiredScopes: [], tokenVerifier }
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

    if (!this.checks.some((c) => c.id === 'iss-client-rejected-unexpected')) {
      const correctlyRejected = this.authReached && !this.tokenRequestMade;
      this.checks.push({
        id: 'iss-client-rejected-unexpected',
        name: 'Client compares unadvertised iss and rejects mismatch',
        description: correctlyRejected
          ? 'Client correctly compared unadvertised iss against recorded issuer and rejected the mismatch'
          : 'Client MUST compare a present iss against the recorded issuer regardless of metadata advertisement, and reject on mismatch',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          serverAdvertisedSupport: false,
          issSentInRedirect: 'https://evil.example.com',
          authReached: this.authReached,
          tokenRequestMade: this.tokenRequestMade
        }
      });
    }

    return this.checks;
  }
}
