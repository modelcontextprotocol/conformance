import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  SpecVersion,
  isSpecVersion,
  specVersionAtLeast
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { SpecReferences } from './spec-references';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import type { Request, Response, NextFunction } from 'express';

/**
 * The authorization requests in a scenario's log, in the order they arrived.
 * Scenarios that judge the Nth authorization request read them here, at
 * judgement time, rather than counting requests as they arrive: on a
 * serverless host consecutive requests can reach processes whose replayed
 * logs each lack the other's, but the log being judged holds them all.
 */
function authorizationRequests(checks: ConformanceCheck[]): ConformanceCheck[] {
  return checks.filter((c) => c.id === 'authorization-request');
}

/**
 * The authorization request that answers the insufficient_scope challenge:
 * the first one logged after the first 403 from the MCP endpoint. A client
 * may start an authorization and abandon it before then (the C# SDK does
 * when its server/discover probe times out mid-flow and it falls back to
 * initialize), so the second authorization request is not reliably the
 * escalation. With no 403 in the log, it is the second request, as before.
 */
function escalationRequest(
  checks: ConformanceCheck[]
): ConformanceCheck | undefined {
  const challenge = checks.findIndex(
    (c) =>
      c.id === 'outgoing-response' &&
      c.details?.path === '/mcp' &&
      c.details?.statusCode === 403
  );
  if (challenge < 0) return authorizationRequests(checks)[1];
  return authorizationRequests(checks.slice(challenge + 1))[0];
}

/** The `scope` parameter of a logged authorization request, if any. */
function requestedScope(authorization: ConformanceCheck): string | undefined {
  const query = authorization.details?.query as
    | Record<string, unknown>
    | undefined;
  return typeof query?.scope === 'string' ? query.scope : undefined;
}

/** The revision createAuthServer recorded on a logged authorization request. */
function specVersionIn(checks: ConformanceCheck[]): SpecVersion | undefined {
  for (const c of authorizationRequests(checks)) {
    const v = c.details?.specVersion;
    if (isSpecVersion(v)) return v;
  }
  return undefined;
}

/**
 * Scenario 1: Client uses scope from WWW-Authenticate header
 *
 * Tests that clients SHOULD follow the scope parameter from the initial
 * WWW-Authenticate header in the 401 response, per the scope selection strategy.
 */
export class ScopeFromWwwAuthenticateScenario extends AuthHandlerScenario {
  name = 'auth/scope-from-www-authenticate';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests that client uses scope parameter from WWW-Authenticate header when provided';
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const expectedScope = 'mcp:basic';
    const tokenVerifier = new MockTokenVerifier(this.checks, [expectedScope]);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
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

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [expectedScope],
      includeScopeInWwwAuth: true,
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = checks.some(
      (c) => c.id === 'scope-from-www-authenticate'
    );
    if (!hasScopeCheck) {
      checks.push({
        id: 'scope-from-www-authenticate',
        name: 'Client scope selection from WWW-Authenticate header',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }
    return checks;
  }
}

/**
 * Scenario 2: Client falls back to scopes_supported when scope not in WWW-Authenticate
 *
 * Tests that clients SHOULD use all scopes from scopes_supported in the PRM
 * when the scope parameter is not available in the WWW-Authenticate header.
 */
export class ScopeFromScopesSupportedScenario extends AuthHandlerScenario {
  name = 'auth/scope-from-scopes-supported';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests that client uses all scopes from scopes_supported when scope not in WWW-Authenticate header';
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const scopesSupported = ['mcp:basic', 'mcp:read', 'mcp:write'];
    const tokenVerifier = new MockTokenVerifier(this.checks, scopesSupported);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
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

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: scopesSupported,
      scopesSupported: scopesSupported,
      includeScopeInWwwAuth: false,
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = checks.some(
      (c) => c.id === 'scope-from-scopes-supported'
    );
    if (!hasScopeCheck) {
      checks.push({
        id: 'scope-from-scopes-supported',
        name: 'Client scope selection from scopes_supported',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }
    return checks;
  }
}

/**
 * Scenario 3: Client omits scope when scopes_supported is undefined
 *
 * Tests that clients SHOULD omit the scope parameter when scopes_supported
 * is not available in the PRM and scope is not in WWW-Authenticate header.
 */
export class ScopeOmittedWhenUndefinedScenario extends AuthHandlerScenario {
  name = 'auth/scope-omitted-when-undefined';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests that client omits scope parameter when scopes_supported is undefined';
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
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

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [],
      scopesSupported: undefined,
      includeScopeInWwwAuth: false,
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    // Emit failure check if expected scope check didn't run
    const hasScopeCheck = checks.some(
      (c) => c.id === 'scope-omitted-when-undefined'
    );
    if (!hasScopeCheck) {
      checks.push({
        id: 'scope-omitted-when-undefined',
        name: 'Client scope omission when scopes_supported undefined',
        description:
          'Client did not complete authorization flow - scope check could not be performed',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }
    return checks;
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
export class ScopeStepUpAuthScenario extends AuthHandlerScenario {
  name = 'auth/scope-step-up';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests that client handles step-up authentication with different scope requirements per operation';
  private checks: ConformanceCheck[] = [];
  // SEP-2350's set-wise union requirement was introduced in 2026-07-28 (the
  // current draft); it was not a requirement at 2025-11-25, where
  // non-accumulating re-auth is conformant. Gate the union check accordingly.
  // An instance that only judges a log gets it from judgeAt(), or failing
  // that from the log; see getChecks().
  private specVersion: SpecVersion | undefined;

  judgeAt(specVersion: SpecVersion): void {
    this.specVersion = specVersion;
  }

  private static readonly initialScope = 'mcp:basic';
  // tools/call gates on mcp:write only (not the union) so the scenario can
  // complete even for clients that don't accumulate; the SEP-2350 check then
  // observes whether the previously-granted mcp:basic was retained.
  private static readonly stepUpScope = 'mcp:write';

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    this.specVersion = ctx.specVersion;
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const { initialScope, stepUpScope } = ScopeStepUpAuthScenario;
    const escalatedScopes = [initialScope, stepUpScope];
    const tokenVerifier = new MockTokenVerifier(this.checks, escalatedScopes);

    // The authorization requests are judged in getChecks(), in order.
    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier
    });

    // Inline step-up auth middleware
    const resourceMetadataUrl = () =>
      `${ctx.getRsBaseUrl()}/.well-known/oauth-protected-resource/mcp`;

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
      const requiredScopes = isToolCall ? [stepUpScope] : [initialScope];

      const hasRequiredScopes = requiredScopes.every((s) =>
        tokenScopes.includes(s)
      );

      if (!hasRequiredScopes) {
        // Has token but insufficient scopes - return 403. Challenge with only
        // the step-up scope so SEP-2350 union accumulation is observable: a
        // client that just echoes the challenge would drop mcp:basic.
        return res
          .status(403)
          .set(
            'WWW-Authenticate',
            `Bearer scope="${stepUpScope}", resource_metadata="${resourceMetadataUrl()}", error="insufficient_scope"`
          )
          .json({
            error: 'insufficient_scope',
            error_description: 'Token has insufficient scope'
          });
      }

      next();
    };

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: escalatedScopes,
      // Deliberately disjoint from initialScope/stepUpScope so the SEP-2350
      // union check can't be satisfied by a client that unions
      // scopes_supported ∪ challenge instead of prior-grant ∪ challenge.
      // The spec allows this: clients MUST NOT assume any set relationship
      // between challenged scopes and scopes_supported.
      scopesSupported: ['mcp:profile'],
      includeScopeInWwwAuth: true,
      authMiddleware: stepUpMiddleware,
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const { initialScope, stepUpScope } = ScopeStepUpAuthScenario;
    const specVersion = this.specVersion ?? specVersionIn(this.checks);
    const unionRequired =
      specVersion !== undefined &&
      specVersionAtLeast(specVersion, DRAFT_PROTOCOL_VERSION);
    const [initial] = authorizationRequests(this.checks);
    const escalation = escalationRequest(this.checks);

    if (initial) {
      // First auth request - should request mcp:basic from WWW-Authenticate
      const scope = requestedScope(initial);
      const usedCorrectScope = (scope?.split(' ') ?? []).includes(initialScope);
      checks.push({
        id: 'scope-step-up-initial',
        name: 'Client initial scope selection for step-up auth',
        description: usedCorrectScope
          ? 'Client correctly used scope from WWW-Authenticate header for initial auth'
          : 'Client SHOULD use the scope parameter from the WWW-Authenticate header',
        status: usedCorrectScope ? 'SUCCESS' : 'WARNING',
        timestamp: initial.timestamp,
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          expectedScope: initialScope,
          requestedScope: scope || 'none'
        }
      });
    }

    if (escalation) {
      // Second auth request after a 403 challenge that listed only the
      // *missing* scope (mcp:write). Two distinct assertions:
      // - escalation: client included the challenged scope at all
      // - SEP-2350 union: client *also* kept the previously-granted scope
      //   that was NOT in the challenge (i.e., computed prior ∪ challenge)
      const scope = requestedScope(escalation);
      const requestedScopes = scope?.split(' ') ?? [];
      const includesChallenged = requestedScopes.includes(stepUpScope);
      checks.push({
        id: 'scope-step-up-escalation',
        name: 'Client scope escalation for step-up auth',
        description: includesChallenged
          ? 'Client correctly requested the challenged scope for step-up authentication'
          : 'Client SHOULD request additional scopes when receiving 403 with new scope requirements',
        status: includesChallenged ? 'SUCCESS' : 'WARNING',
        timestamp: escalation.timestamp,
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY],
        details: {
          challengedScope: stepUpScope,
          requestedScope: scope || 'none'
        }
      });

      if (unionRequired) {
        const retainedPrior = requestedScopes.includes(initialScope);
        checks.push({
          id: 'sep-2350-scope-union-on-reauth',
          name: 'Client accumulates previously-granted scopes on re-authorization',
          description: retainedPrior
            ? 'Client included previously-granted scopes alongside the newly challenged scope when re-authorizing'
            : 'Client SHOULD compute the union of previously requested scopes and newly challenged scopes when initiating re-authorization (SEP-2350); previously-granted scope was dropped',
          status: retainedPrior ? 'SUCCESS' : 'WARNING',
          timestamp: escalation.timestamp,
          specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING],
          details: {
            previouslyGranted: initialScope,
            challengedScope: stepUpScope,
            requestedScope: scope || 'none'
          }
        });
      }
    }

    // Emit failure checks if expected auth requests didn't happen
    if (!initial) {
      checks.push({
        id: 'scope-step-up-initial',
        name: 'Client initial scope selection for step-up auth',
        description: 'Client did not make an initial authorization request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
    }

    if (!escalation) {
      checks.push({
        id: 'scope-step-up-escalation',
        name: 'Client scope escalation for step-up auth',
        description:
          'Client did not make a second authorization request for scope escalation',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_SELECTION_STRATEGY]
      });
      if (unionRequired) {
        checks.push({
          id: 'sep-2350-scope-union-on-reauth',
          name: 'Client accumulates previously-granted scopes on re-authorization',
          description:
            'Client did not make a second authorization request - scope union check could not be performed',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING]
        });
      }
    }

    return checks;
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
export class ScopeRetryLimitScenario extends AuthHandlerScenario {
  name = 'auth/scope-retry-limit';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests that client implements retry limits to prevent infinite authorization loops on repeated 403 responses';
  allowClientError = true;
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const requiredScope = 'mcp:admin';
    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    // Each authorization request is an attempt, counted in getChecks().
    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier
    });

    const resourceMetadataUrl = () =>
      `${ctx.getRsBaseUrl()}/.well-known/oauth-protected-resource/mcp`;

    const maxAttempts = 3;
    // Token-bearing MCP requests answered so far. Every one of them is
    // answered 403 or 410 by the middleware below, and the request logger
    // records each answer, so the count is read from the log (replayed into
    // each process on a serverless host) rather than kept in memory.
    const answeredWithToken = () =>
      this.checks.filter(
        (c) =>
          c.id === 'outgoing-response' &&
          c.details?.path === '/mcp' &&
          (c.details?.statusCode === 403 || c.details?.statusCode === 410)
      ).length;

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

      const mcpRequestWithTokenCount = answeredWithToken() + 1;

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

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      prmPath: '/.well-known/oauth-protected-resource/mcp',
      requiredScopes: [requiredScope],
      scopesSupported: [requiredScope],
      includeScopeInWwwAuth: true,
      authMiddleware: alwaysDeny403Middleware,
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const attempts = authorizationRequests(this.checks);
    attempts.forEach((authorization, i) => {
      const attemptNumber = i + 1;
      checks.push({
        id: 'scope-retry-auth-attempt',
        name: `Authorization attempt ${attemptNumber}`,
        description: `Client made authorization request attempt ${attemptNumber}`,
        status: 'INFO',
        timestamp: authorization.timestamp,
        specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING],
        details: {
          attemptNumber,
          requestedScope: requestedScope(authorization) || 'none'
        }
      });
    });
    const authAttempts = attempts.length;

    if (authAttempts === 0) {
      checks.push({
        id: 'scope-retry-limit',
        name: 'Client retry limit for scope escalation',
        description: 'Client did not make any authorization requests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_SCOPE_CHALLENGE_HANDLING]
      });
    } else if (authAttempts <= 3) {
      checks.push({
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
      checks.push({
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

    return checks;
  }
}
