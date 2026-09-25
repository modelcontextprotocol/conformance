/**
 * DPoP authorization-server scenario (SEP-1932 / RFC 9449).
 *
 * The framework acts as a DPoP-capable OAuth client against the authorization
 * server under test at `options.url`. It probes:
 *
 *  - metadata: `dpop_signing_alg_values_supported` is advertised (RFC 9449 §5.1)
 *    and does not include the `none` or symmetric algorithms;
 *  - token binding: a code exchanged WITH a DPoP proof yields a token bound to
 *    the proof key (`cnf.jkt`) with `token_type: DPoP` (RFC 9449 §5–§6);
 *  - invalid proofs: a tampered signature and an `htu` that is not the token
 *    endpoint are rejected with HTTP 400 `invalid_dpop_proof` (RFC 9449 §5),
 *    but only after the binding check succeeded;
 *  - nonce: when the first exchange is `use_dpop_nonce`, the challenge carries
 *    `DPoP-Nonce`, the retry with that nonce succeeds, and a wrong nonce is
 *    rejected (RFC 9449 §4.3 step 10, §8).
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
import { untestableCheck } from '../untestable';
import { SpecReferences } from './auth/spec-references';

/** Env opt-in for negative probes against a login-gated authorization server. */
export const DPOP_NEGATIVE_PROBES_ENV = 'MCP_CONFORMANCE_DPOP_NEGATIVE_PROBES';

/**
 * True when the operator asked to spend extra authorization codes on DPoP
 * negative probes. Headless servers do not need this; see
 * {@link DPoPAuthorizationServerScenario.negativeProbesAllowed}.
 */
export function dpopNegativeProbesRequested(options: {
  dpopNegativeProbes?: boolean;
}): boolean {
  if (options.dpopNegativeProbes === true) return true;
  const raw = process.env[DPOP_NEGATIVE_PROBES_ENV];
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Why a negative probe cannot be attributed when the valid-proof exchange did
 * not yield a DPoP-bound token. Same shape as the server scenario's gate: an
 * AS that rejects everything must not pass the negatives vacuously.
 */
function gateReason(caseLabel: string): string {
  return `authorization server did not issue a DPoP-bound token for a valid proof, so a rejection of the ${caseLabel} case cannot be distinguished from an authorization server that rejects everything`;
}

/**
 * Cost-control reason. The check is a MUST that applies, but each probe spends
 * an authorization code. On a login-gated AS that is an interactive login, so
 * the probe is not sent unless the operator opts in. Reported via
 * {@link untestableCheck} (FAILURE, `details.untestable`) rather than SKIPPED:
 * SKIPPED is excluded from pass/fail counts and the expected-failures baseline,
 * so a login-gated AS would read as green without these probes. Headless
 * redirects run the probes with no opt-in and never hit this reason.
 */
function interactiveProbeReason(caseLabel: string): string {
  return `authorization required an interactive login, so the ${caseLabel} probe was not sent; re-run with --dpop-negative-probes or ${DPOP_NEGATIVE_PROBES_ENV}=1 to spend an additional authorization code`;
}

function issuedAccessToken(body: Record<string, unknown> | undefined): boolean {
  return typeof body?.access_token === 'string' && body.access_token.length > 0;
}

/**
 * Grade an invalid-proof probe (RFC 9449 §5).
 *
 * - HTTP 400 `invalid_dpop_proof` → SUCCESS
 * - HTTP 200 with an access token → FAILURE (the AS bound a bad proof)
 * - HTTP 400 with any other error → WARNING (rejected, wrong code)
 * - anything else → SKIPPED, the scenario's existing inconclusive rule
 */
export function judgeInvalidDpopProofResponse(
  result: { statusCode: number; body?: Record<string, unknown> },
  caseLabel: string
): { status: CheckStatus; errorMessage?: string } {
  const error = result.body?.error;
  if (result.statusCode === 200 && issuedAccessToken(result.body)) {
    return {
      status: 'FAILURE',
      errorMessage: `Authorization server issued an access token for a ${caseLabel} DPoP proof (HTTP 200)`
    };
  }
  if (result.statusCode === 400 && error === 'invalid_dpop_proof') {
    return { status: 'SUCCESS' };
  }
  if (result.statusCode === 400) {
    return {
      status: 'WARNING',
      errorMessage: `Authorization server rejected the ${caseLabel} DPoP proof with HTTP 400 but error=${String(error ?? 'none')}; expected invalid_dpop_proof`
    };
  }
  return {
    status: 'SKIPPED',
    errorMessage: `${caseLabel} probe was inconclusive (HTTP ${result.statusCode}, error=${String(error ?? 'none')})`
  };
}

/**
 * Grade a wrong-nonce probe. RFC 9449 §8 says the authorization server MUST
 * reject a nonce that does not match one it recently supplied, and names
 * `use_dpop_nonce` for that mismatch. Any 4xx that does not issue a token
 * counts as a rejection; issuing a token is FAILURE. Other statuses follow
 * the scenario's inconclusive rule.
 */
export function judgeWrongNonceRejection(result: {
  statusCode: number;
  body?: Record<string, unknown>;
}): { status: CheckStatus; errorMessage?: string } {
  const error = result.body?.error;
  if (issuedAccessToken(result.body)) {
    return {
      status: 'FAILURE',
      errorMessage: `Authorization server issued an access token for a DPoP proof with the wrong nonce (HTTP ${result.statusCode})`
    };
  }
  if (result.statusCode >= 400 && result.statusCode < 500) {
    return { status: 'SUCCESS' };
  }
  return {
    status: 'SKIPPED',
    errorMessage: `Wrong-nonce probe was inconclusive (HTTP ${result.statusCode}, error=${String(error ?? 'none')})`
  };
}

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
  },
  'sep-1932-as-rejects-invalid-proof': {
    name: 'DpopRejectsInvalidProof',
    description:
      'Authorization server rejects an invalid DPoP proof with HTTP 400 invalid_dpop_proof',
    specReferences: [
      SpecReferences.RFC_9449_TOKEN_REQUEST,
      SpecReferences.RFC_9449_PROOF_CHECKS
    ]
  },
  'sep-1932-as-nonce': {
    name: 'DpopNonce',
    description:
      'Authorization server nonce challenge carries DPoP-Nonce, accepts that nonce, and rejects a wrong one',
    specReferences: [
      SpecReferences.RFC_9449_AS_NONCE,
      SpecReferences.RFC_9449_PROOF_CHECKS
    ]
  }
};

/** Invalid-proof probes. Each spends its own authorization code. */
const INVALID_PROOF_CASES = [
  {
    caseId: 'tampered-signature',
    name: 'RejectsTamperedSignature',
    description:
      'Authorization server rejects a DPoP proof with a tampered signature'
  },
  {
    caseId: 'wrong-htu',
    name: 'RejectsWrongHtu',
    description:
      'Authorization server rejects a DPoP proof whose htu is not the token endpoint'
  }
] as const;

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
  /**
   * Whether the first authorization step in this run followed a redirect to
   * the registered redirect_uri (no interactive login). Later probe
   * authorizations must not overwrite it.
   */
  private firstAuthorizationHeadless: boolean | undefined;
  description = `Test DPoP support in the authorization server (SEP-1932 / RFC 9449).

**Authorization Server Implementation Requirements:**

**Endpoints**: \`authorization server metadata\`, \`authorization endpoint\`, \`token endpoint\`

**Requirements** (checked only when the AS advertises DPoP support):
- Metadata MUST advertise \`dpop_signing_alg_values_supported\` (RFC 9449 §5.1)
- \`dpop_signing_alg_values_supported\` MUST list only asymmetric algorithms (no \`none\` or symmetric algorithms)
- A token issued for a request carrying a DPoP proof MUST be bound to the proof key: \`cnf.jkt\` equals the JWK thumbprint and \`token_type\` is \`DPoP\` (RFC 9449 §5–§6)
- An invalid DPoP proof (tampered signature, or \`htu\` other than the token endpoint) MUST be rejected with HTTP 400 \`invalid_dpop_proof\` (RFC 9449 §5). These probes run only after the binding check succeeded
- When the token endpoint answers with \`use_dpop_nonce\`, the challenge includes a \`DPoP-Nonce\` header, a retry carrying that nonce succeeds, and a proof with a different nonce is rejected (RFC 9449 §4.3 step 10, §8)

An AS that does not advertise \`dpop_signing_alg_values_supported\` is treated as
not supporting DPoP and the scenario SKIPs. Tokens are obtained via the
authorization_code + PKCE grant. The authorization step auto-follows a direct
redirect to the registered redirect_uri, or falls back to an interactive
browser login + callback for login-gated servers. Negative probes each spend
another authorization code. They run automatically on the headless redirect
path. A login-gated server requires \`--dpop-negative-probes\` or
\`MCP_CONFORMANCE_DPOP_NEGATIVE_PROBES=1\`; otherwise those probes are reported
not testable rather than skipped.`;

  async run(
    options: AuthorizationServerOptions,
    _details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    this.firstAuthorizationHeadless = undefined;
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
        'sep-1932-as-token-binding',
        'sep-1932-as-rejects-invalid-proof'
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
        'sep-1932-as-token-binding',
        'sep-1932-as-rejects-invalid-proof'
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
      const reason = 'Requires a client_id (pass --client-id)';
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: reason
        })
      );
      this.skipInvalidProof(reason, checks);
      return;
    }
    if (
      typeof metadata.authorization_endpoint !== 'string' ||
      typeof metadata.token_endpoint !== 'string'
    ) {
      const reason =
        'Metadata is missing authorization_endpoint or token_endpoint';
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: reason
        })
      );
      this.skipInvalidProof(reason, checks);
      return;
    }

    // Negotiate the proof algorithm BEFORE the (possibly interactive) authorize
    // step: if we can't produce one the AS advertises, SKIP now rather than
    // forcing a pointless interactive login only to fail afterwards.
    const alg = this.negotiateProofAlg(metadata);
    if (alg === null) {
      const reason =
        'Authorization server advertises no DPoP proof algorithm the harness can produce, so token binding cannot be exercised';
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: reason,
          details: {
            dpop_signing_alg_values_supported:
              metadata.dpop_signing_alg_values_supported ?? null
          }
        })
      );
      this.skipInvalidProof(reason, checks);
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
      const reason = `Could not obtain an authorization code: ${this.message(error)}`;
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: reason
        })
      );
      this.skipInvalidProof(reason, checks);
      return;
    }

    // Exchange the code WITH a DPoP proof and inspect the binding.
    try {
      const keyPair = await generateDpopKeyPair(alg);
      const exchanged = await this.exchangeWithProof(
        metadata,
        options,
        code,
        codeVerifier,
        keyPair,
        alg
      );
      const binding = this.bindingCheckFor(
        exchanged.final,
        keyPair.thumbprint,
        alg
      );
      checks.push(binding);

      const nonceChallenged =
        exchanged.first.statusCode === 400 &&
        exchanged.first.body?.error === 'use_dpop_nonce';
      if (nonceChallenged) {
        checks.push(this.nonceHeaderCheck(exchanged.first));
        if (exchanged.first.dpopNonce) {
          checks.push(this.nonceRetryCheck(exchanged.final));
        }
      }

      await this.finishNegativeProbes({
        bindingSucceeded: binding.status === 'SUCCESS',
        metadata,
        options,
        keyPair,
        alg,
        suppliedNonce: exchanged.first.dpopNonce,
        nonceChallenged,
        checks
      });
    } catch (error) {
      const reason = `Could not complete the DPoP token exchange: ${this.message(error)}`;
      checks.push(
        this.check('sep-1932-as-token-binding', 'SKIPPED', {
          errorMessage: reason
        })
      );
      this.skipInvalidProof(reason, checks);
    }
  }

  /**
   * Binding judgment for the (possibly nonce-retried) token response. Messages
   * match the pre-negative-probe scenario: only `invalid_dpop_proof` is a
   * binding failure; other non-200 outcomes stay inconclusive.
   */
  private bindingCheckFor(
    result: TokenExchangeResult,
    expectedJkt: string,
    alg: string
  ): ConformanceCheck {
    if (result.statusCode !== 200) {
      // Only a DPoP-specific rejection is a binding failure. Any other token
      // error (e.g. the AS wanted client auth we didn't send) is inconclusive
      // for the binding requirement, so skip rather than mis-attribute a
      // FAILURE against a real third-party AS.
      const dpopRejection = result.body?.error === 'invalid_dpop_proof';
      return this.check(
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
      );
    }

    const binding = readTokenBinding(result.body ?? {});
    // A 200 response with no access_token at all is a plainly broken AS, not
    // an "inconclusive/opaque" case — fail it rather than fall into the SKIP
    // branch below.
    const hasAccessToken = issuedAccessToken(result.body);
    if (!hasAccessToken) {
      return this.check('sep-1932-as-token-binding', 'FAILURE', {
        errorMessage: 'Token response was 200 but carried no access_token',
        details: { tokenType: binding.tokenType ?? null }
      });
    }
    // Only inconclusive when the AS CLAIMS a DPoP binding (token_type=DPoP)
    // but the token is opaque: cnf.jkt can't be read off the wire (it may
    // still hold, verifiable only via introspection) → documented harness gap
    // → SKIP. A non-DPoP token_type is a plain binding failure below, opaque
    // or not, so it does not reach here.
    if (binding.isDpopTokenType && !binding.accessTokenIsJwt) {
      return this.check('sep-1932-as-token-binding', 'SKIPPED', {
        errorMessage:
          'Issued access token is opaque (not a JWT); its cnf.jkt binding cannot be verified off the wire',
        details: { tokenType: binding.tokenType ?? null }
      });
    }
    const bound = binding.isDpopTokenType && binding.jkt === expectedJkt;
    return this.check(
      'sep-1932-as-token-binding',
      bound ? 'SUCCESS' : 'FAILURE',
      {
        errorMessage: bound
          ? undefined
          : 'Issued token is not bound to the DPoP key (expected token_type=DPoP and cnf.jkt to match the proof key)',
        details: {
          tokenType: binding.tokenType ?? null,
          cnfJkt: binding.jkt ?? null,
          expectedJkt
        }
      }
    );
  }

  private nonceHeaderCheck(first: TokenExchangeResult): ConformanceCheck {
    const header = first.dpopNonce;
    const present = typeof header === 'string' && header.length > 0;
    return this.check('sep-1932-as-nonce', present ? 'SUCCESS' : 'FAILURE', {
      name: 'NonceChallengeHeader',
      description:
        'A use_dpop_nonce error response carries a DPoP-Nonce header',
      errorMessage: present
        ? undefined
        : 'Authorization server returned use_dpop_nonce without a DPoP-Nonce header (RFC 9449 §8)',
      details: { case: 'nonce-header', dpopNonce: header ?? null }
    });
  }

  private nonceRetryCheck(final: TokenExchangeResult): ConformanceCheck {
    const accepted = final.statusCode === 200 && issuedAccessToken(final.body);
    return this.check('sep-1932-as-nonce', accepted ? 'SUCCESS' : 'FAILURE', {
      name: 'NonceRetryAccepted',
      description:
        'Retrying the token request with the supplied DPoP nonce is accepted',
      errorMessage: accepted
        ? undefined
        : `Retry with the supplied DPoP nonce was not accepted (HTTP ${final.statusCode}, error=${String(final.body?.error ?? 'none')})`,
      details: {
        case: 'nonce-retry',
        statusCode: final.statusCode,
        error: final.body?.error ?? null
      }
    });
  }

  /**
   * Negative probes run only after a successful binding check. Otherwise they
   * are reported not-testable so an AS that rejects every proof cannot pass
   * them vacuously. Login-gated authorization (no headless redirect) also
   * withholds them unless the operator opts in.
   */
  private async finishNegativeProbes(args: {
    bindingSucceeded: boolean;
    metadata: Record<string, any>;
    options: AuthorizationServerOptions;
    keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>>;
    alg: string;
    suppliedNonce: string | undefined;
    nonceChallenged: boolean;
    checks: ConformanceCheck[];
  }): Promise<void> {
    const {
      bindingSucceeded,
      metadata,
      options,
      keyPair,
      alg,
      suppliedNonce,
      nonceChallenged,
      checks
    } = args;
    const wrongNonceApplies = nonceChallenged && !!suppliedNonce;
    if (!bindingSucceeded) {
      this.emitInvalidProofsNotRun(checks, gateReason);
      if (wrongNonceApplies) {
        this.emitWrongNonceNotRun(checks, gateReason('wrong-nonce'));
      }
      return;
    }
    if (!this.negativeProbesAllowed(options)) {
      this.emitInvalidProofsNotRun(checks, interactiveProbeReason);
      if (wrongNonceApplies) {
        this.emitWrongNonceNotRun(
          checks,
          interactiveProbeReason('wrong-nonce')
        );
      }
      return;
    }
    await this.runInvalidProofProbes(metadata, options, keyPair, alg, checks);
    if (wrongNonceApplies) {
      await this.runWrongNonceProbe(
        metadata,
        options,
        keyPair,
        alg,
        suppliedNonce!,
        checks
      );
    }
  }

  /**
   * Headless redirects spend authorization codes with no human in the loop, so
   * the probes run on their own. An interactive login requires an explicit
   * opt-in (CLI flag or env var).
   */
  protected negativeProbesAllowed(
    options: AuthorizationServerOptions
  ): boolean {
    return (
      this.firstAuthorizationHeadless === true ||
      dpopNegativeProbesRequested(options)
    );
  }

  private emitInvalidProofsNotRun(
    checks: ConformanceCheck[],
    reasonFor: (caseLabel: string) => string
  ): void {
    const specReferences =
      CHECK_DEFS['sep-1932-as-rejects-invalid-proof'].specReferences;
    for (const probe of INVALID_PROOF_CASES) {
      checks.push(
        untestableCheck(
          'sep-1932-as-rejects-invalid-proof',
          probe.name,
          probe.description,
          reasonFor(probe.caseId),
          specReferences
        )
      );
    }
  }

  private emitWrongNonceNotRun(
    checks: ConformanceCheck[],
    reason: string
  ): void {
    const def = CHECK_DEFS['sep-1932-as-nonce'];
    checks.push(
      untestableCheck(
        'sep-1932-as-nonce',
        'NonceRejectsWrongValue',
        'Authorization server rejects a DPoP proof whose nonce does not match the supplied value',
        reason,
        def.specReferences
      )
    );
  }

  private async runInvalidProofProbes(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions,
    keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>>,
    alg: string,
    checks: ConformanceCheck[]
  ): Promise<void> {
    const htu = stripUrlQuery(metadata.token_endpoint);
    for (const probe of INVALID_PROOF_CASES) {
      try {
        const fresh = await this.obtainAuthorizationCode(metadata, options);
        const proof = await buildDpopProof(
          probe.caseId === 'tampered-signature'
            ? { keyPair, htm: 'POST', htu, alg, tamperSignature: true }
            : {
                keyPair,
                htm: 'POST',
                htu: 'https://dpop-negative.invalid/not-the-token-endpoint',
                alg
              }
        );
        const result = await this.exchangeCode(
          metadata,
          options,
          fresh.code,
          fresh.codeVerifier,
          proof
        );
        const judged = judgeInvalidDpopProofResponse(result, probe.caseId);
        checks.push(
          this.check('sep-1932-as-rejects-invalid-proof', judged.status, {
            name: probe.name,
            description: probe.description,
            errorMessage: judged.errorMessage,
            details: {
              case: probe.caseId,
              statusCode: result.statusCode,
              error: result.body?.error ?? null
            }
          })
        );
      } catch (error) {
        checks.push(
          untestableCheck(
            'sep-1932-as-rejects-invalid-proof',
            probe.name,
            probe.description,
            `could not obtain an authorization code for the ${probe.caseId} probe: ${this.message(error)}`,
            CHECK_DEFS['sep-1932-as-rejects-invalid-proof'].specReferences
          )
        );
      }
    }
  }

  /**
   * Single exchange, not {@link exchangeWithProof}: a conformant AS answers a
   * bad nonce with `use_dpop_nonce` plus a fresh nonce, and the retry helper
   * would then send the correct nonce and hide the rejection.
   */
  private async runWrongNonceProbe(
    metadata: Record<string, any>,
    options: AuthorizationServerOptions,
    keyPair: Awaited<ReturnType<typeof generateDpopKeyPair>>,
    alg: string,
    suppliedNonce: string,
    checks: ConformanceCheck[]
  ): Promise<void> {
    const description =
      'Authorization server rejects a DPoP proof whose nonce does not match the supplied value';
    try {
      const fresh = await this.obtainAuthorizationCode(metadata, options);
      const proof = await buildDpopProof({
        keyPair,
        htm: 'POST',
        htu: stripUrlQuery(metadata.token_endpoint),
        alg,
        nonce: `${suppliedNonce}-wrong`
      });
      const result = await this.exchangeCode(
        metadata,
        options,
        fresh.code,
        fresh.codeVerifier,
        proof
      );
      const judged = judgeWrongNonceRejection(result);
      checks.push(
        this.check('sep-1932-as-nonce', judged.status, {
          name: 'NonceRejectsWrongValue',
          description,
          errorMessage: judged.errorMessage,
          details: {
            case: 'wrong-nonce',
            statusCode: result.statusCode,
            error: result.body?.error ?? null
          }
        })
      );
    } catch (error) {
      checks.push(
        untestableCheck(
          'sep-1932-as-nonce',
          'NonceRejectsWrongValue',
          description,
          `could not obtain an authorization code for the wrong-nonce probe: ${this.message(error)}`,
          CHECK_DEFS['sep-1932-as-nonce'].specReferences
        )
      );
    }
  }

  private skipInvalidProof(reason: string, checks: ConformanceCheck[]): void {
    checks.push(
      this.check('sep-1932-as-rejects-invalid-proof', 'SKIPPED', {
        errorMessage: reason
      })
    );
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
  ): Promise<{ first: TokenExchangeResult; final: TokenExchangeResult }> {
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
    // A use_dpop_nonce response with no DPoP-Nonce header is not retried: there
    // is no nonce to put in the proof. The caller records that as a nonce-check
    // failure. Binding then sees this 400, which stays inconclusive.
    if (
      first.statusCode === 400 &&
      first.body?.error === 'use_dpop_nonce' &&
      first.dpopNonce
    ) {
      const final = await this.exchangeCode(
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
      return { first, final };
    }
    return { first, final: first };
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
    // RFC 8707: forward the resource parameter when supplied, aligning with the
    // authorization-code-grant scenario (#466) so a resource-aware AS is exercised.
    if (options.resource) {
      params.set('resource', options.resource);
    }
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
        this.noteAuthorizationPath(true);
        return resolved;
      }
    }

    // Interactive fallback for login-gated authorization servers.
    this.noteAuthorizationPath(false);
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
    // RFC 8707: forward the resource parameter when supplied (aligns with #466).
    if (options.resource) {
      params.set('resource', options.resource);
    }
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

  /** Record only the first authorization step; probe logins must not reset it. */
  private noteAuthorizationPath(headless: boolean): void {
    if (this.firstAuthorizationHeadless === undefined) {
      this.firstAuthorizationHeadless = headless;
    }
  }

  private check(
    id: string,
    status: CheckStatus,
    opts: {
      name?: string;
      description?: string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    } = {}
  ): ConformanceCheck {
    const def = CHECK_DEFS[id];
    return {
      id,
      name: opts.name ?? def.name,
      description: opts.description ?? def.description,
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
