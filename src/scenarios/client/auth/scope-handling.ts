import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls, SpecVersion } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import type { Request, Response, NextFunction } from 'express';

/**
 * Scenario 1: Client uses scope from WWW-Authenticate header
 *
 * Tests that clients SHOULD follow the scope parameter from the initial
 * WWW-Authenticate header in the 401 response, per the scope selection strategy.
 */
export class ScopeFromWwwAuthenticateScenario implements Scenario {
  name = 'auth/scope-from-www-authenticate';
  specVersions: SpecVersion[] = ['2025-11-25'];
  description =
    'Tests that client uses scope parameter from WWW-Authenticate header when provided';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const expectedScope = 'mcp:basic';
    const tokenVerifier = new MockTokenVerifier(this.checks, [expectedScope]);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
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
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = this.checks.some(
      (c) => c.id === 'scope-from-www-authenticate'
    );
    if (!hasScopeCheck) {
      this.checks.push({
        id: 'scope-from-www-authenticate',
        name: 'Client scope selection from WWW-Authenticate header',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
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
  specVersions: SpecVersion[] = ['2025-11-25'];
  description =
    'Tests that client uses all scopes from scopes_supported when scope not in WWW-Authenticate header';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const scopesSupported = ['mcp:basic', 'mcp:read', 'mcp:write'];
    const tokenVerifier = new MockTokenVerifier(this.checks, scopesSupported);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
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
        includeScopeInWwwAuth: false,
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
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = this.checks.some(
      (c) => c.id === 'scope-from-scopes-supported'
    );
    if (!hasScopeCheck) {
      this.checks.push({
        id: 'scope-from-scopes-supported',
        name: 'Client scope selection from scopes_supported',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
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
  specVersions: SpecVersion[] = ['2025-11-25'];
  description =
    'Tests that client omits scope parameter when scopes_supported is undefined';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
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
      }
    });
    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [],
        scopesSupported: undefined,
        includeScopeInWwwAuth: false,
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
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = this.checks.some(
      (c) => c.id === 'scope-omitted-when-undefined'
    );
    if (!hasScopeCheck) {
      this.checks.push({
        id: 'scope-omitted-when-undefined',
        name: 'Client scope omission when scopes_supported undefined',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
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
  specVersions: SpecVersion[] = ['2025-11-25'];
  description =
    'Tests that client handles step-up authentication with different scope requirements per operation';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const initialScope = 'mcp:basic';
    const escalatedScopes = ['mcp:basic', 'mcp:write'];
    const tokenVerifier = new MockTokenVerifier(this.checks, escalatedScopes);
    let authRequestCount = 0;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        authRequestCount++;
        const requestedScopes = data.scope ? data.scope.split(' ') : [];

        if (authRequestCount === 1) {
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
        } else if (authRequestCount === 2) {
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
            `Bearer scope="${requiredScopes.join(' ')}", resource_metadata="${resourceMetadataUrl()}", error="insufficient_scope"`
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

/**
 * Scenario 5: Client implements retry limits for scope escalation
 *
 * Tests that clients SHOULD implement retry limits to avoid infinite
 * authorization loops when receiving repeated 403 insufficient_scope errors.
 * The server always returns 403 with the same scope requirement, and clients
 * should stop retrying after a reasonable number of attempts (3 or fewer).
 */
export class ScopeRetryLimitScenario implements Scenario {
  name = 'auth/scope-retry-limit';
  specVersions: SpecVersion[] = ['2025-11-25'];
  description =
    'Tests that client implements retry limits to prevent infinite authorization loops on repeated 403 responses';
  allowClientError = true;
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const requiredScope = 'mcp:admin';
    const tokenVerifier = new MockTokenVerifier(this.checks, []);
    let authRequestCount = 0;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      onAuthorizationRequest: (data) => {
        authRequestCount++;
        this.checks.push({
          id: 'scope-retry-auth-attempt',
          name: `Authorization attempt ${authRequestCount}`,
          description: `Client made authorization request attempt ${authRequestCount}`,
          status: 'INFO',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING],
          details: {
            attemptNumber: authRequestCount,
            requestedScope: data.scope || 'none'
          }
        });
      }
    });
    await this.authServer.start(authApp);

    const resourceMetadataUrl = () =>
      `${this.server.getUrl()}/.well-known/oauth-protected-resource/mcp`;

    const maxAttempts = 3;
    let mcpRequestWithTokenCount = 0;

    const alwaysDeny403Middleware = async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const method = body?.method;

      if (method === 'initialize' || method?.startsWith('notifications/')) {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer scope="${requiredScope}", resource_metadata="${resourceMetadataUrl()}"`
          )
          .json({
            error: 'invalid_token',
            error_description: 'Missing Authorization header'
          });
      }

      mcpRequestWithTokenCount++;

      if (mcpRequestWithTokenCount > maxAttempts) {
        return res.status(410).json({
          error: 'test_complete',
          error_description:
            'Test is over - client exceeded maximum retry attempts'
        });
      }

      return res
        .status(403)
        .set(
          'WWW-Authenticate',
          `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${resourceMetadataUrl()}", error_description="Scope upgrade will never succeed"`
        )
        .json({
          error: 'insufficient_scope',
          error_description: 'Scope upgrade will never succeed'
        });
    };

    const baseApp = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [requiredScope],
        scopesSupported: [requiredScope],
        includeScopeInWwwAuth: true,
        authMiddleware: alwaysDeny403Middleware,
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
    const authAttempts = this.checks.filter(
      (c) => c.id === 'scope-retry-auth-attempt'
    ).length;

    if (authAttempts === 0) {
      this.checks.push({
        id: 'scope-retry-limit',
        name: 'Client retry limit for scope escalation',
        description: 'Client did not make any authorization requests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING]
      });
    } else if (authAttempts <= 3) {
      this.checks.push({
        id: 'scope-retry-limit',
        name: 'Client retry limit for scope escalation',
        description: `Client correctly limited retry attempts to ${authAttempts} (3 or fewer)`,
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING],
        details: {
          authorizationAttempts: authAttempts,
          maxAllowed: 3
        }
      });
    } else {
      this.checks.push({
        id: 'scope-retry-limit',
        name: 'Client retry limit for scope escalation',
        description: `Client made ${authAttempts} authorization attempts (more than 3). Clients SHOULD implement retry limits to avoid infinite loops.`,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING],
        details: {
          authorizationAttempts: authAttempts,
          maxAllowed: 3
        }
      });
    }

    return this.checks;
  }
}
