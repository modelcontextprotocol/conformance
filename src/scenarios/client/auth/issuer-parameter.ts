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

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'correct',
      onAuthorizationRequest: ({ timestamp }) => {
        this.checks.push({
          id: 'iss-advertised-in-metadata',
          name: 'ISS Parameter Advertised',
          description:
            'Server advertised authorization_response_iss_parameter_supported: true in AS metadata',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
        this.checks.push({
          id: 'iss-sent-in-redirect',
          name: 'ISS Sent in Redirect',
          description:
            'Server included correct iss value in authorization redirect',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
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

    if (!this.checks.some((c) => c.id === 'iss-advertised-in-metadata')) {
      this.checks.push({
        id: 'iss-advertised-in-metadata',
        name: 'ISS Parameter Advertised',
        description:
          'Client did not reach authorization endpoint — could not verify iss parameter handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    if (!this.checks.some((c) => c.id === 'iss-sent-in-redirect')) {
      this.checks.push({
        id: 'iss-sent-in-redirect',
        name: 'ISS Sent in Redirect',
        description:
          'Client did not reach authorization endpoint — could not verify iss in redirect',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

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

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      // issParameterSupported not set — omitted from metadata
      // issInRedirect defaults to 'omit'
      onAuthorizationRequest: ({ timestamp }) => {
        this.checks.push({
          id: 'iss-not-advertised-in-metadata',
          name: 'ISS Parameter Not Advertised',
          description:
            'Client accepted authorization response from server that does not advertise iss parameter support',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
        this.checks.push({
          id: 'iss-not-sent-in-redirect',
          name: 'ISS Not Sent in Redirect',
          description:
            'Client accepted authorization response that does not include an iss parameter',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
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

    if (!this.checks.some((c) => c.id === 'iss-not-advertised-in-metadata')) {
      this.checks.push({
        id: 'iss-not-advertised-in-metadata',
        name: 'ISS Parameter Not Advertised',
        description:
          'Client did not reach authorization endpoint — could not verify iss-absent handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    if (!this.checks.some((c) => c.id === 'iss-not-sent-in-redirect')) {
      this.checks.push({
        id: 'iss-not-sent-in-redirect',
        name: 'ISS Not Sent in Redirect',
        description:
          'Client did not reach authorization endpoint — could not verify absent iss handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

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
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'omit', // advertise support but don't send iss
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
      const correctlyRejected = !this.tokenRequestMade;
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
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'wrong', // send iss that doesn't match metadata issuer
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
      const correctlyRejected = !this.tokenRequestMade;
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
          tokenRequestMade: this.tokenRequestMade
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: ISS Parameter Sent but Not Advertised (client must reject)
 *
 * Server does not advertise authorization_response_iss_parameter_supported but
 * includes an iss value in the redirect anyway. A conformant client MUST reject
 * this unexpected parameter to prevent downgrade attacks.
 */
export class IssParameterUnexpectedScenario implements Scenario {
  name = 'auth/iss-unexpected';
  specVersions: SpecVersion[] = ['draft'];
  description =
    'Tests that client rejects authorization response when server sends iss but did not advertise support';
  allowClientError = true;

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
      // issParameterSupported omitted from metadata
      issParameterSupported: false,
      issInRedirect: 'correct', // but send iss anyway
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
      const correctlyRejected = !this.tokenRequestMade;
      this.checks.push({
        id: 'iss-client-rejected-unexpected',
        name: 'Client rejects unexpected iss',
        description: correctlyRejected
          ? 'Client correctly rejected authorization response containing unexpected iss parameter'
          : 'Client MUST reject authorization response when server sends iss without advertising authorization_response_iss_parameter_supported',
        status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          serverAdvertisedSupport: false,
          issSentInRedirect: true,
          tokenRequestMade: this.tokenRequestMade
        }
      });
    }

    return this.checks;
  }
}
