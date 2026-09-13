/**
 * SEP-2352 — Authorization-server binding and migration.
 *
 * The MCP server's PRM initially lists AS₁. The client registers, authorizes,
 * and calls tools/list. The harness then invalidates the token and flips PRM
 * to AS₂. On the next 401 the client re-discovers PRM, sees a new issuer, and
 * MUST re-register with AS₂ rather than reuse AS₁'s client credentials.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  AuxOriginRole,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { SpecReferences } from './spec-references';

/** AS₁ issues a recognizable client_id so AS₂ can detect cross-AS reuse. */
const AS1_CLIENT_ID = 'as1-client-id-LEAKED-IF-SEEN-AT-AS2';

/**
 * What the client sent AS₂. Both authorization servers log through the same
 * helpers, so these are recorded explicitly: the verdicts are read from the
 * log, where a fresh instance judging a merged log (the hosted server,
 * across processes) finds them too.
 */
const NEW_AS_REQUEST = 'new-authorization-server-request';

function basicAuthClientId(h?: string): string | undefined {
  if (!h?.startsWith('Basic ')) return undefined;
  try {
    const [id] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    return id;
  } catch {
    return undefined;
  }
}

export class AuthorizationServerMigrationScenario extends AuthHandlerScenario {
  name = 'auth/authorization-server-migration';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that a client, when the PRM authorization_servers changes to a new issuer, re-registers with the new authorization server and does not reuse credentials from the previous one (SEP-2352).';
  readonly auxRoles: readonly AuxOriginRole[] = ['as', 'as2'];
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const as1Url = () => ctx.getAuxBaseUrl('as');
    const as2Url = () => ctx.getAuxBaseUrl('as2');
    const tokenVerifier = new MockTokenVerifier(this.checks, ['mcp:basic']);

    const observeAtAs2 = (
      endpoint: 'register' | 'authorize' | 'token',
      clientId: string | undefined,
      timestamp = new Date().toISOString()
    ) => {
      this.checks.push({
        id: NEW_AS_REQUEST,
        name: 'NewAuthorizationServerRequest',
        description: `Client sent a ${endpoint} request to the new authorization server`,
        status: 'INFO',
        timestamp,
        specReferences: [SpecReferences.MCP_AS_BINDING_2026_07_28],
        details: { endpoint, ...(clientId !== undefined && { clientId }) }
      });
    };

    // ── AS₁ ────────────────────────────────────────────────────────────────
    const as1App = createAuthServer(ctx, this.checks, as1Url, {
      tokenVerifier,
      onRegistrationRequest: () => ({
        clientId: AS1_CLIENT_ID,
        clientSecret: 'as1-client-secret'
      })
    });

    // ── AS₂ ────────────────────────────────────────────────────────────────
    const as2App = createAuthServer(ctx, this.checks, as2Url, {
      tokenVerifier,
      onRegistrationRequest: () => {
        observeAtAs2('register', undefined);
        return { clientId: 'as2-client-id', clientSecret: 'as2-client-secret' };
      },
      onAuthorizationRequest: (data) => {
        observeAtAs2('authorize', data.clientId, data.timestamp);
      },
      onTokenRequest: (data) => {
        const cid =
          data.body.client_id ?? basicAuthClientId(data.authorizationHeader);
        observeAtAs2('token', cid, data.timestamp);
        const scopes = data.scope ? data.scope.split(' ') : ['mcp:basic'];
        // createAuthServer registers the token it hands out, with its scopes.
        return { token: `test-token-as2-${Date.now()}`, scopes };
      }
    });

    // ── MCP server with mutable PRM authorization_servers ──────────────────
    // Migrated once the resource server has accepted a token: the verifier
    // logs every token it accepts, so the phase is read from the log (which
    // a serverless host replays into each process) rather than a flag.
    const migrated = () =>
      this.checks.some((c) => c.id === 'valid-bearer-token');
    const currentAuthServerUrl = () => (migrated() ? as2Url() : as1Url());

    const resourceMetadataUrl = () =>
      `${ctx.getRsBaseUrl()}/.well-known/oauth-protected-resource/mcp`;

    const middleware = async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const method = body?.method;
      // initialize / notifications never require auth
      if (method === 'initialize' || method?.startsWith('notifications/'))
        return next();

      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer scope="mcp:basic", resource_metadata="${resourceMetadataUrl()}"`
          )
          .json({ error: 'invalid_token' });
      }
      const token = auth.substring('Bearer '.length);
      const wasMigrated = migrated();
      const info = await tokenVerifier.verifyAccessToken(token);

      // Phase 1: accept any verified token, then flip PRM to AS₂ for the next
      // call. Phase 2: reject the (now-stale) AS₁ token so the client
      // re-discovers PRM and sees AS₂.
      if (!wasMigrated) {
        return next();
      }
      // After migration, only AS₂ tokens are valid.
      if (!info.token.startsWith('test-token-as2-')) {
        return res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer scope="mcp:basic", resource_metadata="${resourceMetadataUrl()}"`
          )
          .json({
            error: 'invalid_token',
            error_description: 'authorization server has changed'
          });
      }
      return next();
    };

    const rsApp = createServer(
      ctx,
      this.checks,
      ctx.getRsBaseUrl,
      currentAuthServerUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: ['mcp:basic'],
        includeScopeInWwwAuth: true,
        authMiddleware: middleware,
        tokenVerifier
      }
    );

    return { rs: rsApp, aux: { as: as1App, as2: as2App } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const atAs2 = this.checks
      .filter((c) => c.id === NEW_AS_REQUEST)
      .map((c) => c.details ?? {});
    const as2SawRegister = atAs2.some((d) => d.endpoint === 'register');
    const as2SawAs1ClientId = atAs2.some(
      (d) => d.endpoint === 'authorize' && d.clientId === AS1_CLIENT_ID
    );
    const as2SawAs1ClientIdAtToken = atAs2.some(
      (d) => d.endpoint === 'token' && d.clientId === AS1_CLIENT_ID
    );

    const ts = new Date().toISOString();
    const reusedAtAS2 = as2SawAs1ClientId || as2SawAs1ClientIdAtToken;
    checks.push({
      id: 'sep-2352-reregister-on-as-change',
      name: 'Client re-registers with the new authorization server',
      description: as2SawRegister
        ? 'Client performed Dynamic Client Registration with the new authorization server after PRM authorization_servers changed'
        : 'Client MUST re-register with the new authorization server when PRM authorization_servers changes (SEP-2352); no registration request was observed at the new AS',
      status: as2SawRegister ? 'SUCCESS' : 'FAILURE',
      timestamp: ts,
      specReferences: [SpecReferences.MCP_AS_BINDING_2026_07_28]
    });
    checks.push({
      id: 'sep-2352-no-reuse-on-as-change',
      name: 'Client does not reuse the previous AS client credentials',
      description: reusedAtAS2
        ? 'Client MUST NOT reuse client credentials from a different authorization server (SEP-2352); the previous AS client_id was observed at the new AS'
        : 'Client did not present the previous AS client_id at the new authorization server',
      status: reusedAtAS2 ? 'FAILURE' : 'SUCCESS',
      timestamp: ts,
      specReferences: [SpecReferences.MCP_AS_BINDING_2026_07_28],
      details: {
        previousClientId: AS1_CLIENT_ID,
        seenAtAuthorize: as2SawAs1ClientId,
        seenAtToken: as2SawAs1ClientIdAtToken
      }
    });
    // The "no cross-AS credential reuse" general MUST NOT is the same wire
    // observation as no-reuse-on-as-change in this scenario; emit it as a
    // distinct id so the yaml traceability is 1:1.
    checks.push({
      id: 'sep-2352-no-cross-as-credential-reuse',
      name: 'Client does not assume credentials are portable across authorization servers',
      description: reusedAtAS2
        ? 'Client MUST NOT assume that credentials valid for one authorization server will be accepted by another (SEP-2352)'
        : 'Client treated credentials as bound to the issuing authorization server',
      status: reusedAtAS2 ? 'FAILURE' : 'SUCCESS',
      timestamp: ts,
      specReferences: [SpecReferences.MCP_AS_LOCATION_2026_07_28]
    });
    return checks;
  }
}
