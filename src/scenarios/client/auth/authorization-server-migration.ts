/**
 * SEP-2352 — Authorization-server binding and migration.
 *
 * The MCP server's PRM initially lists AS₁. The client registers, authorizes,
 * and calls tools/list. The harness then invalidates the token and flips PRM
 * to AS₂. On the next 401 the client re-discovers PRM, sees a new issuer, and
 * MUST re-register with AS₂ rather than reuse AS₁'s client credentials.
 */
import type { ScenarioContext } from '../../../mock-server';
import type { Request, Response, NextFunction } from 'express';
import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls, DRAFT_PROTOCOL_VERSION } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { SpecReferences } from './spec-references';

export class AuthorizationServerMigrationScenario implements Scenario {
  name = 'auth/authorization-server-migration';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that a client, when the PRM authorization_servers changes to a new issuer, re-registers with the new authorization server and does not reuse credentials from the previous one (SEP-2352).';
  private as1 = new ServerLifecycle();
  private as2 = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    const tokenVerifier = new MockTokenVerifier(this.checks, ['mcp:basic']);

    /** AS₁ issues a recognizable client_id so AS₂ can detect cross-AS reuse. */
    const AS1_CLIENT_ID = 'as1-client-id-LEAKED-IF-SEEN-AT-AS2';
    let as2SawRegister = false;
    let as2SawAs1ClientId = false;
    let as2SawAs1ClientIdAtToken = false;

    // ── AS₁ ────────────────────────────────────────────────────────────────
    const as1App = createAuthServer(ctx, this.checks, this.as1.getUrl, {
      tokenVerifier,
      onRegistrationRequest: () => ({
        clientId: AS1_CLIENT_ID,
        clientSecret: 'as1-client-secret'
      })
    });
    await this.as1.start(as1App);

    // ── AS₂ ────────────────────────────────────────────────────────────────
    const as2App = createAuthServer(ctx, this.checks, this.as2.getUrl, {
      tokenVerifier,
      onRegistrationRequest: () => {
        as2SawRegister = true;
        return { clientId: 'as2-client-id', clientSecret: 'as2-client-secret' };
      },
      onAuthorizationRequest: (data) => {
        if (data.clientId === AS1_CLIENT_ID) as2SawAs1ClientId = true;
      },
      onTokenRequest: (data) => {
        const cid =
          data.body.client_id ??
          this.basicAuthClientId(data.authorizationHeader);
        if (cid === AS1_CLIENT_ID) as2SawAs1ClientIdAtToken = true;
        const scopes = data.scope ? data.scope.split(' ') : ['mcp:basic'];
        const token = `test-token-as2-${Date.now()}`;
        tokenVerifier.registerToken(token, scopes);
        return { token, scopes };
      }
    });
    await this.as2.start(as2App);

    // ── MCP server with mutable PRM authorization_servers ──────────────────
    let migrated = false;
    const currentAuthServerUrl = () =>
      migrated ? this.as2.getUrl() : this.as1.getUrl();

    const resourceMetadataUrl = () =>
      `${this.server.getUrl()}/.well-known/oauth-protected-resource/mcp`;

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
      const info = await tokenVerifier.verifyAccessToken(token);

      // Phase 1: accept any verified token, then flip PRM to AS₂ for the next
      // call. Phase 2: reject the (now-stale) AS₁ token so the client
      // re-discovers PRM and sees AS₂.
      if (!migrated) {
        migrated = true;
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

    const app = createServer(
      ctx,
      this.checks,
      this.server.getUrl,
      currentAuthServerUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: ['mcp:basic'],
        includeScopeInWwwAuth: true,
        authMiddleware: middleware,
        tokenVerifier
      }
    );
    await this.server.start(app);

    // Record evaluation closures so getChecks can see them after stop().
    this._evaluate = () => {
      const ts = new Date().toISOString();
      const reusedAtAS2 = as2SawAs1ClientId || as2SawAs1ClientIdAtToken;
      this.checks.push({
        id: 'sep-2352-reregister-on-as-change',
        name: 'Client re-registers with the new authorization server',
        description: as2SawRegister
          ? 'Client performed Dynamic Client Registration with the new authorization server after PRM authorization_servers changed'
          : 'Client MUST re-register with the new authorization server when PRM authorization_servers changes (SEP-2352); no registration request was observed at the new AS',
        status: as2SawRegister ? 'SUCCESS' : 'FAILURE',
        timestamp: ts,
        specReferences: [SpecReferences.MCP_DCR]
      });
      this.checks.push({
        id: 'sep-2352-no-reuse-on-as-change',
        name: 'Client does not reuse the previous AS client credentials',
        description: reusedAtAS2
          ? 'Client MUST NOT reuse client credentials from a different authorization server (SEP-2352); the previous AS client_id was observed at the new AS'
          : 'Client did not present the previous AS client_id at the new authorization server',
        status: reusedAtAS2 ? 'FAILURE' : 'SUCCESS',
        timestamp: ts,
        specReferences: [SpecReferences.MCP_DCR],
        details: {
          previousClientId: AS1_CLIENT_ID,
          seenAtAuthorize: as2SawAs1ClientId,
          seenAtToken: as2SawAs1ClientIdAtToken
        }
      });
      // The "no cross-AS credential reuse" general MUST NOT is the same wire
      // observation as no-reuse-on-as-change in this scenario; emit it as a
      // distinct id so the yaml traceability is 1:1.
      this.checks.push({
        id: 'sep-2352-no-cross-as-credential-reuse',
        name: 'Client does not assume credentials are portable across authorization servers',
        description: reusedAtAS2
          ? 'Client MUST NOT assume that credentials valid for one authorization server will be accepted by another (SEP-2352)'
          : 'Client treated credentials as bound to the issuing authorization server',
        status: reusedAtAS2 ? 'FAILURE' : 'SUCCESS',
        timestamp: ts,
        specReferences: [SpecReferences.MCP_DCR]
      });
    };

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  private _evaluate: () => void = () => {};

  private basicAuthClientId(h?: string): string | undefined {
    if (!h?.startsWith('Basic ')) return undefined;
    try {
      const [id] = Buffer.from(h.slice(6), 'base64')
        .toString('utf8')
        .split(':');
      return id;
    } catch {
      return undefined;
    }
  }

  async stop() {
    await this.server.stop();
    await this.as1.stop();
    await this.as2.stop();
  }

  getChecks(): ConformanceCheck[] {
    this._evaluate();
    return this.checks;
  }
}
