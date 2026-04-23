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
 * client should validate iss and proceed normally (i.e. complete the token
 * exchange).
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
      onAuthorizationRequest: ({ timestamp }) => {
        // AS-side facts: document that the server did its part. These do not
        // by themselves prove the client validated iss — see the
        // `iss-client-accepted-correct` check below for that.
        this.checks.push({
          id: 'iss-advertised-by-server',
          name: 'ISS Parameter Advertised (AS)',
          description:
            'Server advertised authorization_response_iss_parameter_supported: true in AS metadata',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
        this.checks.push({
          id: 'iss-present-in-redirect',
          name: 'ISS Present in Redirect (AS)',
          description:
            'Server included correct iss value in authorization redirect',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
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

    if (!this.checks.some((c) => c.id === 'iss-advertised-by-server')) {
      this.checks.push({
        id: 'iss-advertised-by-server',
        name: 'ISS Parameter Advertised (AS)',
        description:
          'Client did not reach authorization endpoint — could not verify iss parameter handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    if (!this.checks.some((c) => c.id === 'iss-present-in-redirect')) {
      this.checks.push({
        id: 'iss-present-in-redirect',
        name: 'ISS Present in Redirect (AS)',
        description:
          'Client did not reach authorization endpoint — could not verify iss in redirect',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    // Client-side assertion: with a correct iss present, a conformant client
    // MUST accept the response and proceed to exchange the code for a token.
    if (!this.checks.some((c) => c.id === 'iss-client-accepted-correct')) {
      this.checks.push({
        id: 'iss-client-accepted-correct',
        name: 'Client accepts correct iss',
        description: this.tokenRequestMade
          ? 'Client validated iss and proceeded to exchange the authorization code'
          : 'Client did not complete the token exchange — either it rejected a correct iss or aborted for unrelated reasons',
        status: this.tokenRequestMade ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          tokenRequestMade: this.tokenRequestMade
        }
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
  private tokenRequestMade = false;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestMade = false;

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      // Explicitly omit iss support: undefined leaves the key out of AS metadata,
      // 'omit' keeps iss out of the redirect. These match the scenario's name.
      issParameterSupported: undefined,
      issInRedirect: 'omit',
      onAuthorizationRequest: ({ timestamp }) => {
        this.checks.push({
          id: 'iss-not-advertised-by-server',
          name: 'ISS Parameter Not Advertised (AS)',
          description:
            'Server AS metadata does not advertise authorization_response_iss_parameter_supported',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
        this.checks.push({
          id: 'iss-absent-from-redirect',
          name: 'ISS Absent from Redirect (AS)',
          description:
            'Server did not include an iss parameter in the authorization redirect',
          status: 'SUCCESS',
          timestamp,
          specReferences: specRefs
        });
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

    if (!this.checks.some((c) => c.id === 'iss-not-advertised-by-server')) {
      this.checks.push({
        id: 'iss-not-advertised-by-server',
        name: 'ISS Parameter Not Advertised (AS)',
        description:
          'Client did not reach authorization endpoint — could not verify iss-absent handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    if (!this.checks.some((c) => c.id === 'iss-absent-from-redirect')) {
      this.checks.push({
        id: 'iss-absent-from-redirect',
        name: 'ISS Absent from Redirect (AS)',
        description:
          'Client did not reach authorization endpoint — could not verify absent iss handling',
        status: 'FAILURE',
        timestamp,
        specReferences: specRefs
      });
    }

    // Client-side assertion: a client should accept an iss-free response when
    // the AS did not advertise support and should complete the token exchange.
    if (!this.checks.some((c) => c.id === 'iss-client-accepted-absent')) {
      this.checks.push({
        id: 'iss-client-accepted-absent',
        name: 'Client accepts absent iss when not advertised',
        description: this.tokenRequestMade
          ? 'Client accepted authorization response without iss when AS did not advertise support and completed the token exchange'
          : 'Client did not complete the token exchange — a conformant client should proceed when iss is legitimately absent',
        status: this.tokenRequestMade ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          tokenRequestMade: this.tokenRequestMade
        }
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
      // undefined => authorization_response_iss_parameter_supported is omitted
      // from AS metadata entirely; but the server sends iss in the redirect anyway.
      issParameterSupported: undefined,
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
