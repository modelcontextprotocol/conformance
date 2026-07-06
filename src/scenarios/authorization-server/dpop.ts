/**
 * DPoP authorization-server scenario (SEP-1932 / RFC 9449).
 *
 * The framework acts as a DPoP-capable OAuth client against the authorization
 * server under test at `options.url`. It probes:
 *
 *  - metadata: `dpop_signing_alg_values_supported` is advertised (RFC 9449 §5.1)
 *    and does not include the `none` or symmetric algorithms;
 *  - token binding: a code exchanged WITH a DPoP proof yields a token bound to
 *    the proof key (`cnf.jkt`) with `token_type: DPoP` (RFC 9449 §5–§6).
 *
 * An AS that does not advertise `dpop_signing_alg_values_supported` is not a
 * DPoP authorization server (RFC 9449 §5.1 is how support is signalled), so the
 * whole scenario SKIPs rather than failing it — the DPoP checks only apply once
 * the AS opts in. (`dpop_bound_access_tokens` is per-client registration
 * metadata, RFC 9449 §5.2, not an AS capability, so no enforcement check is
 * made here.)
 *
 * Tokens are obtained via the authorization_code + PKCE grant (the MCP grant).
 * The authorization step auto-follows a direct redirect to the registered
 * redirect_uri (the headless path used by auto-approving/test ASs) and falls
 * back to an interactive browser + callback-server wait for login-gated ASs.
 *
 * Emits the sep-1932-as-* check IDs declared in src/seps/sep-1932.yaml.
 */

import {
  CheckStatus,
  ClientScenarioForAuthorizationServer,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  SpecReference
} from '../../types';
import { AuthorizationServerOptions } from '../../schemas';
import { request } from 'undici';
import { createHash, randomBytes } from 'crypto';
import { startCallbackServer } from './auth/helpers/createCallbackServer';
import {
  generateDpopKeyPair,
  buildDpopProof
} from '../client/auth/helpers/dpopProof';
import { readTokenBinding } from '../client/auth/helpers/dpopToken';
import { SpecReferences } from './auth/spec-references';

const REDIRECT_URI_ORIGIN = 'http://127.0.0.1';
const REDIRECT_URI_PATH = '/callback';

/** Static id → (name, description, spec references) for each emitted check. */
const CHECK_DEFS: Record<
  string,
  { name: string; description: string; specReferences: SpecReference[] }
> = {
  'sep-1932-as-metadata-alg-values': {
    name: 'DpopMetadataAlgValues',
    description:
      'Authorization server metadata advertises dpop_signing_alg_values_supported',
    specReferences: [
      SpecReferences.SEP_1932_DPOP,
      SpecReferences.DPOP_EXTENSION,
      SpecReferences.RFC_9449_AS_METADATA
    ]
  },
  'sep-1932-as-no-none-alg': {
    name: 'DpopNoNoneAlg',
    description:
      'dpop_signing_alg_values_supported lists only asymmetric algorithms (no none or symmetric algorithms)',
    specReferences: [
      SpecReferences.RFC_9449_AS_METADATA,
      SpecReferences.RFC_9449_ALGORITHMS
    ]
  },
  'sep-1932-as-token-binding': {
    name: 'DpopTokenBinding',
    description:
      'Issued access token is bound to the DPoP key (cnf.jkt) with token_type DPoP',
    specReferences: [
      SpecReferences.RFC_9449_PUBLIC_KEY_CONFIRMATION,
      SpecReferences.DPOP_EXTENSION
    ]
  }
};

/** Proof-JWS algorithms the harness can generate a key + proof for. */
const SUPPORTED_PROOF_ALGS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA'
];

/**
 * Pick a proof-signing algorithm the harness can produce that the AS also
 * advertises (RFC 9449 §5.1), given `dpop_signing_alg_values_supported`.
 *
 * Returns null (→ the caller SKIPs the binding check) when the value is a
 * non-empty array with no algorithm we support, OR any present-but-non-array
 * shape — a string, `null`, number, or object are all malformed metadata, not
 * "unspecified", so we must not fall back to ES256 (which the AS would reject,
 * mis-scoring binding). Only an EMPTY array falls back to ES256 as a best-effort
 * to still exercise the binding (an empty list is itself flagged by the metadata
 * check). An absent field never reaches here — the scenario's support gate SKIPs
 * the whole scenario upstream — but is treated as the empty case for safety.
 */
export function negotiateProofAlg(
  advertised: unknown,
  supported: readonly string[] = SUPPORTED_PROOF_ALGS
): string | null {
  // Any present-but-non-array value (string / null / number / object) is
  // malformed — SKIP rather than fall back to ES256.
  if (advertised !== undefined && !Array.isArray(advertised)) {
    return null;
  }
  if (Array.isArray(advertised) && advertised.length > 0) {
    const match = advertised.find(
      (a) => typeof a === 'string' && supported.includes(a)
    );
    return typeof match === 'string' ? match : null;
  }
  return 'ES256';
}

/** Strip query + fragment from a URL for use as an `htu` (RFC 9449 §4.2). */
function stripUrlQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

interface CodeResult {
  code: string;
  codeVerifier: string;
}

interface TokenExchangeResult {
  statusCode: number;
  body: Record<string, unknown> | undefined;
  dpopNonce?: string;
}

export class DPoPAuthorizationServerScenario implements ClientScenarioForAuthorizationServer {
  name = 'dpop';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test DPoP support in the authorization server (SEP-1932 / RFC 9449).

**Authorization Server Implementation Requirements:**

**Endpoints**: \`authorization server metadata\`, \`authorization endpoint\`, \`token endpoint\`

**Requirements** (checked only when the AS advertises DPoP support):
- Metadata MUST advertise \`dpop_signing_alg_values_supported\` (RFC 9449 §5.1)
- \`dpop_signing_alg_values_supported\` MUST list only asymmetric algorithms (no \`none\` or symmetric algorithms)
- A token issued for a request carrying a DPoP proof MUST be bound to the proof key: \`cnf.jkt\` equals the JWK thumbprint and \`token_type\` is \`DPoP\` (RFC 9449 §5–§6)

An AS that does not advertise \`dpop_signing_alg_values_supported\` is treated as
not supporting DPoP and the scenario SKIPs. Tokens are obtained via the
authorization_code + PKCE grant. The authorization step auto-follows a direct
redirect to the registered redirect_uri, or falls back to an interactive
browser login + callback for login-gated servers.`;

  async run(
    options: AuthorizationServerOptions,
    _details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let metadata: Record<string, any>;
    try {
      metadata = await this.fetchMetadata(options.url);
    } catch (error) {
      checks.push(
        this.check('sep-1932-as-metadata-alg-values', 'FAILURE', {
          errorMessage: `Could not fetch authorization server metadata: ${this.message(error)}`
        })
      );
      for (const id of [
        'sep-1932-as-no-none-alg',
        'sep-1932-as-token-binding'
      ]) {
        checks.push(
          this.check(id, 'SKIPPED', {
            errorMessage: 'Authorization server metadata unavailable'
          })
        );
      }
      return checks;
    }

    // Support gate (RFC 9449 §5.1): an AS signals DPoP support by advertising
    // `dpop_signing_alg_values_supported`. If the field is absent the AS is not
    // a DPoP server and the DPoP requirements do not apply, so the scenario
    // SKIPs rather than failing. (An empty/invalid value IS a claim of support,
    // so it falls through and fails the metadata check below.)
    if (metadata.dpop_signing_alg_values_supported === undefined) {
      const reason =
        'Authorization server does not advertise dpop_signing_alg_values_supported (not a DPoP authorization server)';
      for (const id of [
        'sep-1932-as-metadata-alg-values',
        'sep-1932-as-no-none-alg',
        'sep-1932-as-token-binding'
      ]) {
        checks.push(this.check(id, 'SKIPPED', { errorMessage: reason }));
      }
      return checks;
    }

    this.checkMetadataAlgValues(metadata, checks);
    await this.checkTokenEndpointBehaviour(metadata, options, checks);

    return checks;
  }

  // ----- metadata checks -----

  private checkMetadataAlgValues(
    metadata: Record<string, any>,
    checks: ConformanceCheck[]
  ): void {
    const algValues = metadata.dpop_signing_alg_values_supported;
    const isNonEmptyArray = Array.isArray(algValues) && algValues.length > 0;

    checks.push(
      this.check(
        'sep-1932-as-metadata-alg-values',
        isNonEmptyArray ? 'SUCCESS' : 'FAILURE',
        {
          errorMessage: isNonEmptyArray
            ? undefined
            : 'Metadata is missing a non-empty dpop_signing_alg_values_supported array',
          details: { dpop_signing_alg_values_supported: algValues ?? null }
        }
      )
    );

    // RFC 9449 §11.6 / the extension: only asymmetric algorithms are
    // permitted — the `none` algorithm and symmetric (HMAC, `HS*`) algorithms
    // MUST NOT appear in the advertised list.
    const list: unknown[] = Array.isArray(algValues) ? algValues : [];
    const forbidden = list.filter(
      (a) =>
        typeof a === 'string' &&
        (a.toLowerCase() === 'none' || a.toUpperCase().startsWith('HS'))
    );
    checks.push(
      this.check(
        'sep-1932-as-no-none-alg',
        forbidden.length > 0 ? 'FAILURE' : 'SUCCESS',
        {
          errorMessage:
            forbidden.length > 0
              ? `dpop_signing_alg_values_supported MUST list only asymmetric algorithms; found non-asymmetric: ${forbidden.join(', ')}`
              : undefined,
          details: {
            dpop_signing_alg_values_supported: algValues ?? null,
            ...(forbidden.length > 0 ? { forbidden } : {})
          }
        }
      )
    );
  }

  // ----- token-endpoint check (DPoP token binding) -----

  private async checkTokenEndpointBehaviour(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions,
    checks: ConformanceCheck[]
  ): Promise<void> {
    if (!options.clientId) {
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: 'Requires a client_id (pass --client-id)'
        })
      );
      return;
    }
    if (
      typeof metadata.authorization_endpoint !== 'string' ||
      typeof metadata.token_endpoint !== 'string'
    ) {
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage:
            'Metadata is missing authorization_endpoint or token_endpoint'
        })
      );
      return;
    }

    // Negotiate the proof algorithm BEFORE the (possibly interactive) authorize
    // step: if we can't produce one the AS advertises, SKIP now rather than
    // forcing a pointless interactive login only to fail afterwards.
    const alg = this.negotiateProofAlg(metadata);
    if (alg === null) {
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage:
            'Authorization server advertises no DPoP proof algorithm the harness can produce, so token binding cannot be exercised',
          details: {
            dpop_signing_alg_values_supported:
              metadata.dpop_signing_alg_values_supported ?? null
          }
        })
      );
      return;
    }

    // Acquire the authorization code first, in its OWN try/catch, so a failure
    // here is reported as "could not obtain a code" and never conflated with a
    // token-exchange or binding problem below (which is what a single wrapping
    // catch used to do).
    let code: string;
    let codeVerifier: string;
    try {
      ({ code, codeVerifier } = await this.obtainAuthorizationCode(
        metadata,
        options
      ));
    } catch (error) {
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: `Could not obtain an authorization code: ${this.message(error)}`
        })
      );
      return;
    }

    // Exchange the code WITH a DPoP proof and inspect the binding.
    try {
      const keyPair = await generateDpopKeyPair(alg);
      const result = await this.exchangeWithProof(
        metadata,
        options,
        code,
        codeVerifier,
        keyPair,
        alg
      );

      if (result.statusCode !== 200) {
        // Only a DPoP-specific rejection is a binding failure. Any other token
        // error (e.g. the AS wanted client auth we didn't send) is inconclusive
        // for the binding requirement, so skip rather than mis-attribute a
        // FAILURE against a real third-party AS.
        const dpopRejection = result.body?.error === 'invalid_dpop_proof';
        checks.push(
          this.check(
            'sep-1932-as-token-binding',
            dpopRejection ? 'FAILURE' : 'SKIPPED',
            {
              errorMessage: dpopRejection
                ? `Authorization server rejected a valid DPoP proof (HTTP ${result.statusCode}, error=invalid_dpop_proof)`
                : `Could not complete the token exchange for a non-DPoP reason (HTTP ${result.statusCode}, error=${result.body?.error ?? 'none'}); binding is inconclusive`,
              details: {
                statusCode: result.statusCode,
                error: result.body?.error ?? null,
                alg
              }
            }
          )
        );
        return;
      }

      const binding = readTokenBinding(result.body ?? {});
      // A 200 response with no access_token at all is a plainly broken AS, not
      // an "inconclusive/opaque" case — fail it rather than fall into the SKIP
      // branch below.
      const hasAccessToken =
        typeof result.body?.access_token === 'string' &&
        result.body.access_token.length > 0;
      if (!hasAccessToken) {
        checks.push(
          this.check('sep-1932-as-token-binding', 'FAILURE', {
            errorMessage: 'Token response was 200 but carried no access_token',
            details: { tokenType: binding.tokenType ?? null }
          })
        );
        return;
      }
      // Only inconclusive when the AS CLAIMS a DPoP binding (token_type=DPoP)
      // but the token is opaque: cnf.jkt can't be read off the wire (it may
      // still hold, verifiable only via introspection) → documented harness gap
      // → SKIP. A non-DPoP token_type is a plain binding failure below, opaque
      // or not, so it does not reach here.
      if (binding.isDpopTokenType && !binding.accessTokenIsJwt) {
        checks.push(
          this.check('sep-1932-as-token-binding', 'SKIPPED', {
            errorMessage:
              'Issued access token is opaque (not a JWT); its cnf.jkt binding cannot be verified off the wire',
            details: { tokenType: binding.tokenType ?? null }
          })
        );
        return;
      }
      const bound =
        binding.isDpopTokenType && binding.jkt === keyPair.thumbprint;
      checks.push(
        this.check('sep-1932-as-token-binding', bound ? 'SUCCESS' : 'FAILURE', {
          errorMessage: bound
            ? undefined
            : 'Issued token is not bound to the DPoP key (expected token_type=DPoP and cnf.jkt to match the proof key)',
          details: {
            tokenType: binding.tokenType ?? null,
            cnfJkt: binding.jkt ?? null,
            expectedJkt: keyPair.thumbprint
          }
        })
      );
    } catch (error) {
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: `Could not complete the DPoP token exchange: ${this.message(error)}`
        })
      );
    }
  }

  /** See the module-level {@link negotiateProofAlg}. */
  private negotiateProofAlg(metadata: Record<string, any>): string | null {
    return negotiateProofAlg(metadata.dpop_signing_alg_values_supported);
  }

  /**
   * Choose a token-endpoint client-authentication method from the AS's
   * advertised methods (RFC 8414 §2: an omitted list defaults to
   * client_secret_basic). Mirrors the authorization-code-grant scenario's
   * selection; unsupported methods (…_jwt / tls_client_auth) yield null.
   */
  private selectTokenAuthMethod(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions
  ): 'none' | 'client_secret_post' | 'client_secret_basic' | null {
    const authMethods: string[] =
      metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (!options.clientSecret || authMethods.includes('none')) return 'none';
    if (authMethods.includes('client_secret_post')) return 'client_secret_post';
    if (authMethods.includes('client_secret_basic')) {
      return 'client_secret_basic';
    }
    return null;
  }

  /**
   * Exchange the code with a DPoP proof, completing the nonce handshake if the
   * AS demands one (RFC 9449 §8): a `400 use_dpop_nonce` + `DPoP-Nonce` response
   * is retried once with the supplied nonce before the result is judged.
   */
  private async exchangeWithProof(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions,
    code: string,
    codeVerifier: string,
    keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>>,
    alg: string
  ): Promise<TokenExchangeResult> {
    // RFC 9449 §4.2: htu carries no query/fragment, but RFC 6749 permits them in
    // the token endpoint URL — strip them so we don't build a proof our own (and
    // a conformant AS's) validator would reject.
    const htu = stripUrlQuery(metadata.token_endpoint);
    const first = await this.exchangeCode(
      metadata,
      options,
      code,
      codeVerifier,
      await buildDpopProof({ keyPair, htm: 'POST', htu, alg })
    );
    if (
      first.statusCode === 400 &&
      first.body?.error === 'use_dpop_nonce' &&
      first.dpopNonce
    ) {
      return this.exchangeCode(
        metadata,
        options,
        code,
        codeVerifier,
        await buildDpopProof({
          keyPair,
          htm: 'POST',
          htu,
          alg,
          nonce: first.dpopNonce
        })
      );
    }
    return first;
  }

  // ----- authorization_code + PKCE helpers -----

  private async obtainAuthorizationCode(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions
  ): Promise<CodeResult> {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const redirectUri = `${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH}`;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: options.clientId!,
      state,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    const authorizeUrl = `${metadata.authorization_endpoint}?${params.toString()}`;

    const responseUrl = await this.resolveAuthorizationResponse(
      authorizeUrl,
      redirectUri,
      options
    );
    const code = this.validateAuthorizationResponse(
      responseUrl,
      metadata,
      redirectUri,
      state
    );
    return { code, codeVerifier };
  }

  /**
   * Auto-follow a direct redirect to the registered redirect_uri (headless
   * path); otherwise print the URL and wait for an interactive browser callback.
   */
  private async resolveAuthorizationResponse(
    authorizeUrl: string,
    redirectUri: string,
    options: AuthorizationServerOptions
  ): Promise<string> {
    // undici's request() does not follow redirects, so a 3xx is returned as-is
    // with its Location header — exactly what we want to inspect.
    const res = await request(authorizeUrl, { method: 'GET' });
    const rawLocation = res.headers['location'];
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    await res.body.text().catch(() => undefined); // drain the socket

    if (
      res.statusCode >= 300 &&
      res.statusCode < 400 &&
      typeof location === 'string'
    ) {
      // Location may be relative (RFC 9110 §10.2.2 permits a relative-ref);
      // resolve it against the request URL before matching the redirect_uri.
      const resolved = new URL(location, authorizeUrl).toString();
      if (resolved.startsWith(redirectUri)) {
        return resolved;
      }
    }

    // Interactive fallback for login-gated authorization servers.
    const callback = startCallbackServer(options.port);
    try {
      console.log(
        `Ensure ${redirectUri} is registered as a redirect URI for client '${options.clientId}'.`
      );
      console.log(
        'Access the following URL in your browser and complete authentication:'
      );
      console.log(authorizeUrl);
      console.log('Waiting up to 5 minutes for the authorization callback...');
      return await callback.waitForCallback(300_000);
    } finally {
      callback.close();
    }
  }

  private validateAuthorizationResponse(
    responseUrl: string,
    metadata: Record<string, any>,
    redirectUri: string,
    state: string
  ): string {
    const url = new URL(responseUrl);

    if (url.searchParams.has('error')) {
      const error = url.searchParams.get('error');
      const desc = url.searchParams.get('error_description');
      throw new Error(`Authorization error: ${error} ${desc ?? ''}`.trim());
    }

    const expected = new URL(redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new Error(
        `Unexpected redirect target: ${url.origin}${url.pathname}`
      );
    }

    const stateParams = url.searchParams.getAll('state');
    if (stateParams.length !== 1 || stateParams[0] !== state) {
      throw new Error(
        `Invalid state parameter: ${stateParams.join(',') || 'missing'}`
      );
    }

    const code = url.searchParams.getAll('code');
    if (code.length !== 1 || code[0] === '') {
      throw new Error(`Invalid code parameter: ${code.join(',') || 'missing'}`);
    }

    const iss = url.searchParams.getAll('iss');
    if (iss.length > 0 && (iss.length !== 1 || iss[0] !== metadata.issuer)) {
      throw new Error(`Invalid iss parameter: ${iss.join(',')}`);
    }

    return code[0];
  }

  private async exchangeCode(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions,
    code: string,
    codeVerifier: string,
    proof?: string
  ): Promise<TokenExchangeResult> {
    const redirectUri = `${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH}`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: options.clientId!
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded'
    };
    if (proof) {
      headers['dpop'] = proof;
    }
    // Client authentication per the AS's advertised methods (RFC 8414 default is
    // client_secret_basic when the field is omitted). No secret → public client.
    const authMethod = this.selectTokenAuthMethod(metadata, options);
    if (authMethod === 'client_secret_basic' && options.clientSecret) {
      const credentials = `${encodeURIComponent(options.clientId!)}:${encodeURIComponent(options.clientSecret)}`;
      headers['authorization'] =
        `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else if (authMethod === 'client_secret_post' && options.clientSecret) {
      params.set('client_secret', options.clientSecret);
    }

    const res = await request(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body: params.toString()
    });

    const rawNonce = res.headers['dpop-nonce'];
    const dpopNonce = Array.isArray(rawNonce) ? rawNonce[0] : rawNonce;

    let body: Record<string, unknown> | undefined;
    try {
      body = (await res.body.json()) as Record<string, unknown>;
    } catch {
      await res.body.text().catch(() => undefined);
      body = undefined;
    }
    return { statusCode: res.statusCode, body, dpopNonce };
  }

  // ----- metadata discovery -----

  private async fetchMetadata(serverUrl: string): Promise<Record<string, any>> {
    for (const url of this.createWellKnownUrls(serverUrl)) {
      try {
        const res = await request(url, { method: 'GET' });
        if (res.statusCode === 200) {
          return (await res.body.json()) as Record<string, any>;
        }
        await res.body.text().catch(() => undefined);
      } catch {
        // Try the next candidate URL.
      }
    }
    throw new Error('No authorization server metadata endpoint returned 200');
  }

  private createWellKnownUrls(serverUrl: string): string[] {
    const base = new URL(serverUrl);
    const origin = base.origin;
    const path = base.pathname.replace(/\/$/, '');
    const urls = new Set<string>();
    urls.add(`${origin}/.well-known/oauth-authorization-server${path}`);
    urls.add(`${origin}/.well-known/openid-configuration${path}`);
    urls.add(`${origin}${path}/.well-known/openid-configuration`);
    return Array.from(urls);
  }

  // ----- check construction -----

  private check(
    id: string,
    status: CheckStatus,
    opts: {
      errorMessage?: string;
      details?: Record<string, unknown>;
    } = {}
  ): ConformanceCheck {
    const def = CHECK_DEFS[id];
    return {
      id,
      name: def.name,
      description: def.description,
      status,
      timestamp: new Date().toISOString(),
      specReferences: def.specReferences,
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      ...(opts.details ? { details: opts.details } : {})
    };
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
