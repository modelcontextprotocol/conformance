import type { Scenario, ConformanceCheck } from '../../../types.js';
import { ScenarioUrls } from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { ServerLifecycle } from './helpers/serverLifecycle.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import type { Request, Response, NextFunction } from 'express';

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
 * - initialize/notifications do not require auth
 * - listTools requires mcp:basic scope (401 if missing)
 * - tools/call requires mcp:basic + mcp:write scopes (403 if insufficient)
 * Client must handle both 401 and 403 responses with different scope requirements
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
    const escalatedScopes = ['mcp:basic', 'mcp:write'];
    const tokenVerifier = new MockTokenVerifier(this.checks, escalatedScopes);
    let authorizedScopes: string[] = [];

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        const requestNumber = this.authorizationRequests.length + 1;
        this.authorizationRequests.push({
          scope: data.scope,
          timestamp: data.timestamp
        });
        const requestedScopes = data.scope ? data.scope.split(' ') : [];

        authorizedScopes = requestedScopes;

        if (requestNumber === 1) {
          // First auth request - should request mcp:basic from WWW-Authenticate
          const usedCorrectScope = requestedScopes.includes(initialScope);
          this.checks.push({
            id: 'scope-step-up-initial',
            name: 'Client initial scope selection for step-up auth',
            description: usedCorrectScope
              ? 'Client correctly used scope from WWW-Authenticate header for initial auth'
              : 'Client SHOULD use the scope parameter from the WWW-Authenticate header',
            status: usedCorrectScope ? 'SUCCESS' : 'WARNING',
            timestamp: data.timestamp,
            specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
            details: {
              expectedScope: initialScope,
              requestedScope: data.scope || 'none'
            }
          });
        } else if (requestNumber === 2) {
          // Second auth request - should escalate to mcp:basic + mcp:write
          const hasAllScopes = escalatedScopes.every((s) =>
            requestedScopes.includes(s)
          );
          this.checks.push({
            id: 'scope-step-up-escalation',
            name: 'Client scope escalation for step-up auth',
            description: hasAllScopes
              ? 'Client correctly escalated scopes for step-up authentication'
              : 'Client SHOULD request additional scopes when receiving 403 with new scope requirements',
            status: hasAllScopes ? 'SUCCESS' : 'WARNING',
            timestamp: data.timestamp,
            specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
            details: {
              expectedScopes: escalatedScopes.join(' '),
              requestedScope: data.scope || 'none'
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

    // Inline step-up auth middleware
    const resourceMetadataUrl = () =>
      `${this.server.getUrl()}/.well-known/oauth-protected-resource/mcp`;

    const stepUpMiddleware = async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      // Parse body to check method
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const method = body?.method;

      // Allow initialize and notifications without auth
      if (method === 'initialize' || method?.startsWith('notifications/')) {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // No auth - return 401 with initial scope
        return res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer scope="${initialScope}", resource_metadata="${resourceMetadataUrl()}"`
          )
          .json({
            error: 'invalid_token',
            error_description: 'Missing Authorization header'
          });
      }

      const token = authHeader.substring('Bearer '.length);
      const authInfo = await tokenVerifier.verifyAccessToken(token);
      const tokenScopes = authInfo.scopes || [];

      // Determine required scopes based on method
      const isToolCall = method === 'tools/call';
      const requiredScopes = isToolCall ? escalatedScopes : [initialScope];

      const hasRequiredScopes = requiredScopes.every((s) =>
        tokenScopes.includes(s)
      );

      if (!hasRequiredScopes) {
        // Has token but insufficient scopes - return 403
        return res
          .status(403)
          .set(
            'WWW-Authenticate',
            `Bearer scope="${requiredScopes.join(' ')}", resource_metadata="${resourceMetadataUrl()}"`
          )
          .json({
            error: 'insufficient_scope',
            error_description: 'Token has insufficient scope'
          });
      }

      next();
    };

    const baseApp = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: escalatedScopes,
        scopesSupported: escalatedScopes,
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
    // Emit failure checks if expected auth requests didn't happen
    const hasInitialCheck = this.checks.some(
      (c) => c.id === 'scope-step-up-initial'
    );
    const hasEscalationCheck = this.checks.some(
      (c) => c.id === 'scope-step-up-escalation'
    );

    if (!hasInitialCheck) {
      this.checks.push({
        id: 'scope-step-up-initial',
        name: 'Client initial scope selection for step-up auth',
        description: 'Client did not make an initial authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }

    if (!hasEscalationCheck) {
      this.checks.push({
        id: 'scope-step-up-escalation',
        name: 'Client scope escalation for step-up auth',
        description:
          'Client did not make a second authorization request for scope escalation',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }

    return this.checks;
  }
}
