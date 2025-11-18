import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import { stepUpAuthMiddleware } from './helpers/stepUpAuthMiddleware.js';

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

        // Check if client used the scope from WWW-Authenticate header
        const requestedScopes = data.scope ? data.scope.split(' ') : [];
        const usedCorrectScope = requestedScopes.includes(expectedScope);
        this.checks.push({
          id: 'scope-from-www-authenticate',
          name: 'Client scope selection from WWW-Authenticate header',
          description: usedCorrectScope
            ? 'Client correctly used the scope parameter from the WWW-Authenticate header'
            : 'Client SHOULD use the scope parameter from the WWW-Authenticate header when provided',
          status: usedCorrectScope ? 'SUCCESS' : 'WARNING',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
          details: {
            expectedScope,
            requestedScope: data.scope || 'none'
          }
        });
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
        // Don't add to supported scopes to ensure client uses scope from header
        // scopesSupported: [expectedScope],
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
    // Check if client made at least one authorization request
    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scope-from-www-authenticate',
        name: 'Client scope selection from WWW-Authenticate header',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
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

        // Check if client requested all scopes from scopes_supported
        const requestedScopes = data.scope ? data.scope.split(' ') : [];
        const hasAllScopes = scopesSupported.every((scope) =>
          requestedScopes.includes(scope)
        );
        this.checks.push({
          id: 'scope-from-scopes-supported',
          name: 'Client scope selection from scopes_supported',
          description: hasAllScopes
            ? 'Client correctly used all scopes from scopes_supported in PRM when scope not in WWW-Authenticate'
            : 'Client SHOULD use all scopes from scopes_supported when scope not available in WWW-Authenticate header',
          status: hasAllScopes ? 'SUCCESS' : 'WARNING',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
          details: {
            scopesSupported: scopesSupported.join(' '),
            requestedScope: data.scope || 'none',
            ...(hasAllScopes
              ? {}
              : {
                  missingScopes: scopesSupported
                    .filter((s) => !requestedScopes.includes(s))
                    .join(' ')
                })
          }
        });
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
    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scope-from-scopes-supported',
        name: 'Client scope selection from scopes_supported',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
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

        // Check if client omitted scope parameter
        const scopeOmitted = !data.scope || data.scope.trim() === '';
        this.checks.push({
          id: 'scope-omitted-when-undefined',
          name: 'Client scope omission when scopes_supported undefined',
          description: scopeOmitted
            ? 'Client correctly omitted scope parameter when scopes_supported is undefined'
            : 'Client SHOULD omit scope parameter when scopes_supported is undefined and scope not in WWW-Authenticate',
          status: scopeOmitted ? 'SUCCESS' : 'WARNING',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
          details: {
            scopeParameter: scopeOmitted ? 'omitted' : data.scope
          }
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
        id: 'scope-omitted-when-undefined',
        name: 'Client scope omission when scopes_supported undefined',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }

    return this.checks;
  }
}

/**
 * Scenario 4: Client performs step-up authentication
 *
 * Tests that clients handle step-up authentication where:
 * - Initial request (listTools) requires mcp:basic scope
 * - Subsequent tool calls require mcp:write scope
 * Client must handle 401 responses with different scope requirements
 */
export class ScopeStepUpAuthScenario implements Scenario {
  name = 'auth/scope-step-up';
  description =
    'Tests that client handles step-up authentication with different scope requirements per operation';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private authorizationRequests: Array<{ scope?: string; timestamp: string }> =
    [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.authorizationRequests = [];

    const initialScope = 'mcp:basic';
    const toolCallScope = 'mcp:write';
    const scopesSupported = [initialScope, toolCallScope];
    const tokenVerifier = new MockTokenVerifier(this.checks, scopesSupported);
    let authorizedScopes: string[] = [];

    const uniqueScopes = new Set<string>();
    let stepUpCheckEmitted = false;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        this.authorizationRequests.push({
          scope: data.scope,
          timestamp: data.timestamp
        });
        authorizedScopes = data.scope ? data.scope.split(' ') : [];

        // Track unique scopes across all requests
        if (data.scope) {
          data.scope.split(' ').forEach((s) => uniqueScopes.add(s));
        }

        // Only emit check once we've seen escalation (2+ unique scopes)
        // This happens on the second authorization request if client properly escalates
        if (uniqueScopes.size >= 2 && !stepUpCheckEmitted) {
          stepUpCheckEmitted = true;
          this.checks.push({
            id: 'scope-step-up',
            name: 'Client scope escalation for step-up auth',
            description:
              'Client correctly escalated scopes for step-up authentication',
            status: 'SUCCESS',
            timestamp: data.timestamp,
            specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
            details: {
              requestedScopes: Array.from(uniqueScopes).join(' '),
              requestCount: this.authorizationRequests.length
            }
          });
        }
      },
      onTokenRequest: (_data) => {
        return {
          token: `test-token-${Date.now()}`,
          scopes: authorizedScopes
        };
      }
    });
    await this.authServer.start(authApp);

    const stepUpMiddleware = stepUpAuthMiddleware({
      verifier: tokenVerifier,
      resourceMetadataUrl: `${this.server.getUrl()}/.well-known/oauth-protected-resource/mcp`,
      initialScopes: [initialScope],
      toolCallScopes: [initialScope, toolCallScope]
    });

    const baseApp = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: scopesSupported,
        scopesSupported: scopesSupported,
        includeScopeInWwwAuth: true,
        authMiddleware: stepUpMiddleware,
        tokenVerifier
      }
    );

    await this.server.start(baseApp);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Check if we already emitted a step-up check (success case)
    const hasStepUpCheck = this.checks.some((c) => c.id === 'scope-step-up');

    if (this.authorizationRequests.length === 0) {
      this.checks.push({
        id: 'scope-step-up',
        name: 'Client scope escalation for step-up auth',
        description: 'Client did not make an authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    } else if (!hasStepUpCheck) {
      // Client made auth requests but didn't escalate scopes
      const uniqueScopes = new Set<string>();
      this.authorizationRequests.forEach((req) => {
        if (req.scope) {
          req.scope.split(' ').forEach((s) => uniqueScopes.add(s));
        }
      });
      this.checks.push({
        id: 'scope-step-up',
        name: 'Client scope escalation for step-up auth',
        description: 'Client SHOULD request additional scopes for tool calls',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          requestedScopes: Array.from(uniqueScopes).join(' ') || 'none',
          requestCount: this.authorizationRequests.length
        }
      });
    }

    return this.checks;
  }
}
