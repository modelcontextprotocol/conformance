import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';

/**
 * Scenario 1: Client uses scope from WWW-Authenticate header
 *
 * Tests that clients SHOULD follow the scope parameter from the initial
 * WWW-Authenticate header in the 401 response, per the scope selection strategy.
 */
export class ScopeFromWwwAuthenticateScenario implements Scenario {
  name = 'auth/scope-from-www-authenticate';
  description =
    'Tests that client uses scope parameter from WWW-Authenticate header when provided';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequests: Array<{ scope?: string; timestamp: string }> =
    [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequests = [];

    const expectedScope = 'mcp:basic';
    const tokenVerifier = new MockTokenVerifier(this.checks, [expectedScope]);
    let authorizedScopes: string[] = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        this.authorizationRequests.push({
          scope: data.scope,
          timestamp: data.timestamp
        });
        // Remember the scopes from authorization for token issuance
        authorizedScopes = data.scope ? data.scope.split(' ') : [];
      },
      onTokenRequest: (_data) => {
        // Use scopes from authorization, not from token request
        return {
          token: `test-token-${Date.now()}`,
          scopes: authorizedScopes
        };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [expectedScope],
        scopesSupported: [expectedScope],
        includeScopeInWwwAuth: true,
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
    const expectedScope = 'mcp:basic';

    // Check if client made at least one authorization request
    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scope-from-header-no-auth-request',
        name: 'No authorization request made',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
      return this.checks;
    }

    // Check if client used the scope from WWW-Authenticate header
    const firstRequest = this.authorizationRequests[0];
    const requestedScopes = firstRequest.scope
      ? firstRequest.scope.split(' ')
      : [];

    if (requestedScopes.includes(expectedScope)) {
      this.checks.push({
        id: 'scope-from-header-correct',
        name: 'Client used scope from WWW-Authenticate header',
        description:
          'Client correctly used the scope parameter from the WWW-Authenticate header',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          expectedScope,
          requestedScope: firstRequest.scope
        }
      });
    } else {
      this.checks.push({
        id: 'scope-from-header-incorrect',
        name: 'Client did not use scope from WWW-Authenticate header',
        description:
          'Client SHOULD use the scope parameter from the WWW-Authenticate header when provided',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          expectedScope,
          requestedScope: firstRequest.scope || 'none'
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario 2: Client falls back to scopes_supported when scope not in WWW-Authenticate
 *
 * Tests that clients SHOULD use all scopes from scopes_supported in the PRM
 * when the scope parameter is not available in the WWW-Authenticate header.
 */
export class ScopeFromScopesSupportedScenario implements Scenario {
  name = 'auth/scope-from-scopes-supported';
  description =
    'Tests that client uses all scopes from scopes_supported when scope not in WWW-Authenticate header';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequests: Array<{ scope?: string; timestamp: string }> =
    [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequests = [];

    const scopesSupported = ['mcp:basic', 'mcp:read', 'mcp:write'];
    const tokenVerifier = new MockTokenVerifier(this.checks, scopesSupported);
    let authorizedScopes: string[] = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        this.authorizationRequests.push({
          scope: data.scope,
          timestamp: data.timestamp
        });
        // Remember the scopes from authorization for token issuance
        authorizedScopes = data.scope ? data.scope.split(' ') : [];
      },
      onTokenRequest: (_data) => {
        // Use scopes from authorization, not from token request
        return {
          token: `test-token-${Date.now()}`,
          scopes: authorizedScopes
        };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: scopesSupported,
        scopesSupported: scopesSupported,
        includeScopeInWwwAuth: false, // Don't include scope in WWW-Authenticate
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
    const scopesSupported = ['mcp:basic', 'mcp:read', 'mcp:write'];

    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scopes-supported-no-auth-request',
        name: 'No authorization request made',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
      return this.checks;
    }

    const firstRequest = this.authorizationRequests[0];
    const requestedScopes = firstRequest.scope
      ? firstRequest.scope.split(' ')
      : [];

    // Check if client requested all scopes from scopes_supported
    const hasAllScopes = scopesSupported.every((scope) =>
      requestedScopes.includes(scope)
    );

    if (hasAllScopes) {
      this.checks.push({
        id: 'scopes-supported-all-requested',
        name: 'Client requested all scopes from scopes_supported',
        description:
          'Client correctly used all scopes from scopes_supported in PRM when scope not in WWW-Authenticate',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          scopesSupported: scopesSupported.join(' '),
          requestedScope: firstRequest.scope
        }
      });
    } else {
      this.checks.push({
        id: 'scopes-supported-not-all-requested',
        name: 'Client did not request all scopes from scopes_supported',
        description:
          'Client SHOULD use all scopes from scopes_supported when scope not available in WWW-Authenticate header',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          scopesSupported: scopesSupported.join(' '),
          requestedScope: firstRequest.scope || 'none',
          missingScopes: scopesSupported
            .filter((s) => !requestedScopes.includes(s))
            .join(' ')
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario 3: Client omits scope when scopes_supported is undefined
 *
 * Tests that clients SHOULD omit the scope parameter when scopes_supported
 * is not available in the PRM and scope is not in WWW-Authenticate header.
 */
export class ScopeOmittedWhenUndefinedScenario implements Scenario {
  name = 'auth/scope-omitted-when-undefined';
  description =
    'Tests that client omits scope parameter when scopes_supported is undefined';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequests: Array<{ scope?: string; timestamp: string }> =
    [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequests = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        this.authorizationRequests.push({
          scope: data.scope,
          timestamp: data.timestamp
        });
      },
      onTokenRequest: (_data) => {
        return {
          token: `test-token-${Date.now()}`,
          scopes: []
        };
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [], // No scopes required
        scopesSupported: undefined, // No scopes_supported in PRM
        includeScopeInWwwAuth: false, // No scope in WWW-Authenticate
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
    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scope-omitted-no-auth-request',
        name: 'No authorization request made',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
      return this.checks;
    }

    const firstRequest = this.authorizationRequests[0];

    if (!firstRequest.scope || firstRequest.scope.trim() === '') {
      this.checks.push({
        id: 'scope-omitted-correct',
        name: 'Client correctly omitted scope parameter',
        description:
          'Client correctly omitted scope parameter when scopes_supported is undefined',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          scopeParameter: 'omitted'
        }
      });
    } else {
      this.checks.push({
        id: 'scope-omitted-incorrect',
        name: 'Client included scope parameter when it should be omitted',
        description:
          'Client SHOULD omit scope parameter when scopes_supported is undefined and scope not in WWW-Authenticate',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          requestedScope: firstRequest.scope
        }
      });
    }

    return this.checks;
  }
}
