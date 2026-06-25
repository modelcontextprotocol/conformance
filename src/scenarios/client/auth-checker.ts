/**
 * Auth checker — a stateless re-auth chain.
 *
 * One MCP server, three auth rungs. Each rung is reached by forcing the
 * client back through authorization under a DIFFERENT configuration, using
 * only the spec's own signals:
 *
 *   rung 1 "basic"   401 challenge → PRM #1 → AS #1: PKCE S256 + DCR +
 *                    RFC 8707 resource indicator.
 *   rung 2 "scoped"  calling advance_to_scoped with a basic token → 401
 *                    whose WWW-Authenticate points at PRM #2 (different AS,
 *                    SEP-835: scope must be taken from scopes_supported).
 *   rung 3 "step-up" calling advance_to_stepup with only conformance:read →
 *                    403 insufficient_scope, scope="… conformance:write"
 *                    (RFC 6750 step-up at the same AS).
 *
 * The access token IS the progress report: `ac.<base64url{cfg,scope}>`, so
 * possession of a token with cfg=scoped and conformance:write proves the
 * client handled discovery, a challenge-driven AS switch, SEP-835 scope
 * selection, and 403 step-up — with zero server-side state. The final
 * auth_complete tool spells that out.
 *
 * Like the consent gate in checker-2026-07-28, the embedded ASs are
 * deliverers of specific challenge shapes, not auth conformance tests in
 * themselves — but unlike the consent gate they auto-redirect, so the whole
 * chain is automatable.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import type { ConformanceCheck } from '../../types';
import { HandlerScenario } from '../../types';

const SERVER_INFO = { name: 'mcp-checker-auth', version: '1.0.0' };

const SCOPE_READ = 'conformance:read';
const SCOPE_WRITE = 'conformance:write';

type Cfg = 'basic' | 'scoped' | 'isstrap';

interface TokenClaims {
  cfg: Cfg;
  scope: string;
  /** Set on tokens minted through the iss-mismatch trap — see rung 4. */
  trap?: string;
}

function mintToken(claims: TokenClaims): string {
  return `ac.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
}

function parseToken(authorization: string | undefined): TokenClaims | undefined {
  const m = /^Bearer ac\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!m) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(m[1], 'base64url').toString());
    if (!['basic', 'scoped', 'isstrap'].includes(claims.cfg)) return undefined;
    return {
      cfg: claims.cfg,
      scope: String(claims.scope ?? ''),
      ...(claims.trap ? { trap: String(claims.trap) } : {})
    };
  } catch {
    return undefined;
  }
}

const hasScope = (t: TokenClaims, scope: string) =>
  t.scope.split(' ').includes(scope);

/** What each successfully-reached rung proves about the client. */
const RUNG_PROOF: Record<string, string> = {
  auth_status: 'you completed at least one full authorization flow',
  advance_to_scoped:
    'your client handled a mid-session 401 whose WWW-Authenticate pointed ' +
    'at a DIFFERENT resource_metadata, re-discovered, re-registered at the ' +
    'second AS, and requested the scope advertised in scopes_supported ' +
    '(SEP-835)',
  advance_to_stepup:
    'your client handled a 403 insufficient_scope challenge by ' +
    're-authorizing with the broader scope from the challenge (RFC 6750 ' +
    'step-up) while staying at the same AS',
  auth_complete:
    'ALL AUTH RUNGS PASSED: initial discovery + PKCE S256 + DCR + RFC 8707 ' +
    'resource indicator (rung 1), challenge-driven AS switch + SEP-835 ' +
    'scope selection (rung 2), 403 insufficient_scope step-up (rung 3)'
};

const TOOLS = [
  {
    name: 'auth_status',
    description:
      'Reports which auth rung your current access token proves. Call this ' +
      'first and after each advance.'
  },
  {
    name: 'advance_to_scoped',
    description:
      'Rung 2 gate. With a rung-1 (basic) token this returns HTTP 401 whose ' +
      'WWW-Authenticate names a different resource_metadata — re-authorize ' +
      'through it (note its scopes_supported) and retry.'
  },
  {
    name: 'advance_to_stepup',
    description:
      `Rung 3 gate. Requires ${SCOPE_WRITE}; with only ${SCOPE_READ} this ` +
      'returns HTTP 403 insufficient_scope naming the scope to add — ' +
      're-authorize with it and retry.'
  },
  {
    name: 'auth_complete',
    description:
      'The finish line. Succeeds only with a token proving every rung; the ' +
      'result is the full report.'
  },
  {
    name: 'check_iss_validation',
    description:
      'OPTIONAL TRAP (RFC 9207 / SEP-2468). Calling this returns a 401 ' +
      'pointing at an AS that advertises ' +
      'authorization_response_iss_parameter_supported: true but sends a ' +
      'WRONG iss in the authorization response. This tool can NEVER return ' +
      'success: a conformant client refuses to exchange the code (your own ' +
      "client errors about the iss mismatch — that error IS the pass). A " +
      'client that exchanges the code anyway receives a poisoned token, and ' +
      'every request made with it fails with an explanation. Run this last; ' +
      'it ends the session either way.'
  }
].map((t) => ({ ...t, inputSchema: { type: 'object', properties: {} } }));

export class AuthCheckerScenario extends HandlerScenario {
  name = 'checker-auth';
  description =
    'Stateless auth re-auth chain: each tool rung forces re-authorization ' +
    'under a different configuration (401 with a different ' +
    'resource_metadata, then 403 insufficient_scope step-up). The access ' +
    'token encodes progress; auth_complete succeeds only after every rung.';
  readonly source = { introducedIn: '2025-06-18' } as const;
  mcpPath = '';

  private checks: ConformanceCheck[] = [];

  handler(getBaseUrl: () => string): express.Application {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const base = () => new URL(getBaseUrl());
    const basePath = () => (base().pathname === '/' ? '' : base().pathname);
    const prmUrl = (cfg: Cfg) =>
      `${base().origin}/.well-known/oauth-protected-resource${basePath()}${cfg === 'basic' ? '' : `/cfg/${cfg}`}`;
    const issuer = (cfg: Cfg) => `${getBaseUrl()}/as/${cfg}`;
    /** The deliberately-wrong iss value the trap AS puts in its redirects. */
    const wrongIss = () => `${getBaseUrl()}/as/mixup-attacker`;

    const record = (
      id: string,
      ok: boolean,
      description: string,
      details?: Record<string, unknown>
    ) => {
      this.checks.push({
        id,
        name: id,
        description,
        status: ok ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Auth',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization'
          }
        ],
        details
      });
    };

    // ---------------- protected resource metadata (three variants) --------
    const prmDoc = (cfg: Cfg) => ({
      resource: getBaseUrl(),
      authorization_servers: [issuer(cfg)],
      bearer_methods_supported: ['header'],
      // SEP-835: rung 2's PRM advertises the scope the client must request.
      // Deliberately ONLY the read scope — the write scope must be learned
      // from the rung-3 403 challenge, otherwise an SDK that requests all of
      // scopes_supported up front would never exercise the step-up path.
      ...(cfg === 'scoped' ? { scopes_supported: [SCOPE_READ] } : {})
    });
    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json(prmDoc('basic'));
    });
    app.get('/.well-known/oauth-protected-resource/cfg/scoped', (_req, res) => {
      res.json(prmDoc('scoped'));
    });
    app.get('/.well-known/oauth-protected-resource/cfg/isstrap', (_req, res) => {
      res.json(prmDoc('isstrap'));
    });

    // ---------------- the two ASs (path-based issuers, stateless) ---------
    const asMetadata = (cfg: Cfg) => (_req: Request, res: Response) => {
      res.json({
        issuer: issuer(cfg),
        authorization_endpoint: `${issuer(cfg)}/authorize`,
        token_endpoint: `${issuer(cfg)}/token`,
        registration_endpoint: `${issuer(cfg)}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(cfg === 'scoped' ? { scopes_supported: [SCOPE_READ, SCOPE_WRITE] } : {}),
        // RFC 9207: the trap AS PROMISES iss in authorization responses —
        // which obliges the client to validate it. The redirect then carries
        // a wrong one.
        ...(cfg === 'isstrap'
          ? { authorization_response_iss_parameter_supported: true }
          : {})
      });
    };
    for (const cfg of ['basic', 'scoped', 'isstrap'] as const) {
      app.get(`/.well-known/oauth-authorization-server/as/${cfg}`, asMetadata(cfg));
      app.get(`/.well-known/openid-configuration/as/${cfg}`, asMetadata(cfg));

      app.post(`/as/${cfg}/register`, (req, res) => {
        res.status(201).json({
          ...req.body,
          client_id: `checker-auth-${cfg}-client`,
          token_endpoint_auth_method: 'none'
        });
      });

      app.get(`/as/${cfg}/authorize`, (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const fail = (error: string, description: string) => {
          if (!q.redirect_uri) {
            res.status(400).json({ error, error_description: description });
            return;
          }
          const r = new URL(q.redirect_uri);
          r.searchParams.set('error', error);
          r.searchParams.set('error_description', description);
          if (q.state !== undefined) r.searchParams.set('state', q.state);
          res.redirect(r.toString());
        };
        if (q.code_challenge === undefined || q.code_challenge_method !== 'S256') {
          fail('invalid_request', 'PKCE with S256 is required');
          return;
        }
        if (cfg === 'basic' && q.resource === undefined) {
          fail(
            'invalid_target',
            'RFC 8707: include the resource parameter naming the MCP server'
          );
          return;
        }
        const requested = (q.scope ?? '').split(' ').filter(Boolean);
        if (cfg === 'scoped' && !requested.includes(SCOPE_READ)) {
          fail(
            'invalid_scope',
            `SEP-835: request the scopes advertised in the PRM scopes_supported (at least ${SCOPE_READ}); got '${q.scope ?? ''}'`
          );
          return;
        }
        record(
          `auth-checker-authorize-${cfg}`,
          true,
          `Conformant authorization request at the '${cfg}' AS`,
          { scope: q.scope }
        );
        if (!q.redirect_uri) {
          res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
          return;
        }
        const r = new URL(q.redirect_uri);
        r.searchParams.set(
          'code',
          Buffer.from(
            JSON.stringify({
              cfg,
              challenge: q.code_challenge,
              scope: requested.join(' ')
            })
          ).toString('base64url')
        );
        if (q.state !== undefined) r.searchParams.set('state', q.state);
        // The trap: metadata promised iss, the response lies about it. A
        // conformant client compares this against the issuer it authorized
        // at and refuses to exchange the code (RFC 9207 §2.4).
        if (cfg === 'isstrap') r.searchParams.set('iss', wrongIss());
        res.redirect(r.toString());
      });

      app.post(`/as/${cfg}/token`, (req, res) => {
        const grant = req.body as Record<string, string | undefined>;
        let code: { cfg?: string; challenge?: string; scope?: string };
        try {
          code = JSON.parse(
            Buffer.from(String(grant.code ?? ''), 'base64url').toString()
          );
        } catch {
          code = {};
        }
        if (grant.grant_type !== 'authorization_code' || code.cfg !== cfg) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        const expected = createHash('sha256')
          .update(String(grant.code_verifier ?? ''))
          .digest('base64url');
        if (expected !== code.challenge) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'PKCE verification failed'
          });
          return;
        }
        const scope = code.scope ?? '';
        // Exchanging a trap code means the client ignored the iss mismatch —
        // the token records the offense and incriminates every later request.
        res.json({
          access_token: mintToken({
            cfg,
            scope,
            ...(cfg === 'isstrap'
              ? { trap: 'exchanged-code-despite-iss-mismatch' }
              : {})
          }),
          token_type: 'Bearer',
          expires_in: 3600,
          ...(scope ? { scope } : {})
        });
      });
    }

    // ---------------- landing -------------------------------------------
    app.get('/', (req, res) => {
      if (!String(req.headers.accept ?? '').includes('text/html')) {
        res.status(405).json({
          error: 'POST JSON-RPC to this URL (auth required)',
          docs: 'open this URL in a browser for a full explanation'
        });
        return;
      }
      res.type('html').send(`<!doctype html>
<html><head><title>MCP Checker — Auth Chain</title>
<style>body{font-family:system-ui;max-width:46em;margin:3em auto;line-height:1.55;padding:0 1em}
code,pre{background:#f3f4f6;border-radius:4px}code{padding:.1em .3em}pre{padding:.8em;overflow-x:auto}
h1{margin-bottom:.2em}.muted{color:#6b7280}ol li{margin:.4em 0}</style></head>
<body>
<h1>MCP Checker — Auth Chain</h1>
<p class="muted">Checks a client's OAuth behavior by forcing it back through
authorization under different configurations, using only the spec's own signals.
Stateless: the access token itself encodes your progress.</p>
<ol>
<li><strong>Rung 1 — basic:</strong> any unauthenticated request → 401. Complete
discovery, DCR, PKCE (S256), and send the RFC 8707 <code>resource</code> parameter.</li>
<li><strong>Rung 2 — AS switch + scopes:</strong> call <code>advance_to_scoped</code> →
401 whose <code>WWW-Authenticate</code> names a <em>different</em> resource_metadata.
Re-authorize there, requesting the scope from <code>scopes_supported</code> (SEP-835).</li>
<li><strong>Rung 3 — step-up:</strong> call <code>advance_to_stepup</code> →
403 <code>insufficient_scope</code> naming <code>${SCOPE_WRITE}</code>. Re-authorize with it.</li>
<li><strong>Finish:</strong> <code>auth_complete</code> succeeds only with the final token
and prints the full report.</li>
<li><strong>Optional trap — iss validation (RFC 9207):</strong> <code>check_iss_validation</code>
challenges you toward an AS whose metadata promises <code>iss</code> in authorization
responses, then sends a <em>wrong</em> one. A conformant client refuses to exchange the
code — your client's own iss-mismatch error is the pass. A client that exchanges anyway
gets a poisoned token and every request with it fails with the explanation. Run it last;
it ends the session either way.</li>
</ol>
<p>Your token is readable: <code>ac.&lt;base64url JSON&gt;</code> — decode it any time to
see what your client has proven.</p>
</body></html>`);
    });

    // ---------------- the MCP endpoint, gated per rung -------------------
    // HTTP header values must be Latin-1; keep the rich text in the body.
    const headerSafe = (s: string) => s.replace(/[^\x20-\x7e]/g, '-');
    const challenge401 = (
      res: Response,
      cfg: Cfg,
      description: string
    ) => {
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          `Bearer error="invalid_token", error_description="${headerSafe(description)}", resource_metadata="${prmUrl(cfg)}"`
        )
        .json({ error: 'invalid_token', error_description: description });
    };

    app.post('/', async (req: Request, res: Response) => {
      const token = parseToken(req.headers.authorization);
      const body =
        req.body && !Array.isArray(req.body)
          ? (req.body as { method?: string; params?: { name?: string } })
          : {};

      if (!token) {
        challenge401(
          res,
          'basic',
          'Rung 1: authorize via the resource_metadata in this challenge'
        );
        return;
      }

      // NOTE: a poisoned token (minted by exchanging a wrong-iss code) is
      // NOT rejected at the HTTP layer. Doing so delivered the verdict on the
      // SDK's reconnect/initialize POST — a layer the agent never sees, so
      // the failure surfaced as an opaque "reconnect failed: HTTP 400". We
      // accept the token (the session stays alive) and instead fail the
      // check_iss_validation TOOL CALL in-band below, matching every other
      // rung's verdict style. Safe: the harness controls both ASs.

      // Gate the advance tools at the HTTP layer so the failures are real
      // OAuth challenges, not tool errors — that is the whole trick.
      const toolName =
        body.method === 'tools/call' ? body.params?.name : undefined;

      // The iss trap. A non-poisoned token gets challenged toward the trap AS
      // (a conformant client refuses mid-OAuth and never comes back — that
      // out-of-band refusal is the PASS). A poisoned token means the client
      // exchanged the wrong-iss code: fall through to the SDK dispatch, which
      // returns the FAIL verdict as an in-band tool result.
      if (toolName === 'check_iss_validation' && !token.trap) {
        record('auth-checker-iss-trap-armed', true, 'iss trap challenge issued');
        challenge401(
          res,
          'isstrap',
          'iss validation check: re-authorize via the resource_metadata in this challenge. If your client validates iss (RFC 9207) it will refuse to complete - that refusal is the PASS'
        );
        return;
      }
      if (toolName === 'advance_to_scoped' && token.cfg !== 'scoped') {
        record('auth-checker-rung2-challenged', true, 'Rung 2 challenge issued');
        challenge401(
          res,
          'scoped',
          'Rung 2: this rung requires the second AS configuration — re-authorize via the resource_metadata in this challenge and note its scopes_supported'
        );
        return;
      }
      if (
        (toolName === 'advance_to_stepup' || toolName === 'auth_complete') &&
        !(token.cfg === 'scoped' && hasScope(token, SCOPE_WRITE))
      ) {
        if (token.cfg !== 'scoped') {
          challenge401(res, 'scoped', 'Complete rung 2 before rung 3');
          return;
        }
        record('auth-checker-rung3-challenged', true, 'Rung 3 step-up issued');
        res
          .status(403)
          .set(
            'WWW-Authenticate',
            `Bearer error="insufficient_scope", scope="${SCOPE_READ} ${SCOPE_WRITE}", resource_metadata="${prmUrl('scoped')}"`
          )
          .json({
            error: 'insufficient_scope',
            error_description: `Rung 3: re-authorize with '${SCOPE_WRITE}' (RFC 6750 step-up)`
          });
        return;
      }

      // Gate passed — serve via the SDK (per-request, stateless).
      const server = new Server(SERVER_INFO, {
        capabilities: { tools: {} },
        instructions:
          'Auth-chain checker. Call auth_status, then advance_to_scoped, ' +
          'then advance_to_stepup, then auth_complete. Each advance forces ' +
          'a re-authorization under a different configuration; an HTTP ' +
          '401/403 along the way is the next challenge, not a failure.'
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS
      }));
      server.setRequestHandler(
        CallToolRequestSchema,
        async (request): Promise<CallToolResult> => {
          // iss trap, fail path: reached only with a poisoned token, i.e.
          // the client exchanged a code whose response carried a wrong iss.
          // Deliver the verdict in-band so it surfaces as a tool result, not
          // a swallowed transport error — and keep the session alive.
          if (request.params.name === 'check_iss_validation') {
            record(
              'auth-checker-iss-trap-caught',
              false,
              'Client exchanged an authorization code despite an iss mismatch',
              { iss: wrongIss(), expected: issuer('isstrap') }
            );
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'FAIL [check_iss_validation]: client exchanged an ' +
                    `authorization code whose response carried iss='${wrongIss()}', ` +
                    `expected '${issuer('isstrap')}' (RFC 9207 / SEP-2468). The ` +
                    'trap AS advertised ' +
                    'authorization_response_iss_parameter_supported: true, so a ' +
                    'conformant client MUST compare iss against the issuer it ' +
                    'authorized at and abort BEFORE the token exchange. ' +
                    'Reaching this tool result means your client did not — ' +
                    'leaving it open to authorization-server mix-up attacks.'
                }
              ],
              isError: true
            };
          }
          const proof = RUNG_PROOF[request.params.name];
          if (!proof) {
            return {
              content: [
                {
                  type: 'text',
                  text: `unknown tool '${request.params.name}'`
                }
              ],
              isError: true
            };
          }
          record(`auth-checker-${request.params.name}`, true, proof, {
            cfg: token.cfg,
            scope: token.scope
          });
          const status =
            request.params.name === 'auth_status'
              ? `Token: cfg=${token.cfg}, scope='${token.scope}' — ${
                  token.cfg === 'basic'
                    ? 'rung 1 done; call advance_to_scoped next.'
                    : hasScope(token, SCOPE_WRITE)
                      ? 'all rungs done; call auth_complete.'
                      : 'rung 2 done; call advance_to_stepup next.'
                }`
              : proof;
          return {
            content: [
              {
                type: 'text',
                text: `CONFORMANCE OK [${request.params.name}]: ${status}`
              }
            ]
          };
        }
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    });

    return app;
  }

  getChecks(): ConformanceCheck[] {
    return this.checks;
  }
}
