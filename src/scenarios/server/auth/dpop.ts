/**
 * DPoP server proof-validation scenario (SEP-1932 / RFC 9449).
 *
 * The framework acts as a DPoP client against the MCP server under test: it
 * presents a valid DPoP-bound access token + proof (expect acceptance) and a
 * battery of deliberately-malformed requests (expect 401), recording one check
 * per case. Emits the sep-1932-server-* check IDs declared in
 * src/seps/sep-1932.yaml.
 *
 * Token-issuer trust is supplied via env so the server under test can validate
 * the access token (the compliant example server reads the matching public key):
 *   DPOP_ISSUER_PRIVATE_JWK (JSON), DPOP_ISSUER. Falls back to an ephemeral
 *   issuer if unset (only a server configured to trust it will then pass).
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../../types';
import {
  buildStandardHeaders,
  withRequestMeta,
  type RunContext
} from '../../../connection';
import { request } from 'undici';
import { untestableCheck } from '../../untestable';
import {
  generateDpopKeyPair,
  buildDpopProof as baseBuildDpopProof
} from '../../client/auth/helpers/dpopProof';
import {
  generateIssuerKey,
  importIssuerKey,
  mintDpopBoundToken,
  type TokenIssuerKey
} from '../../client/auth/helpers/dpopToken';
import { SpecReferences } from './spec-references';

const SPEC_REFERENCES = [
  SpecReferences.SEP_1932_DPOP,
  SpecReferences.DPOP_EXTENSION,
  SpecReferences.RFC_9449_CHECKING_PROOFS,
  SpecReferences.RFC_9449_AUTH_SCHEME,
  SpecReferences.RFC_9449_NONCE,
  SpecReferences.RFC_9449_ALGORITHMS
];

interface Probe {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function probeBody(specVersion: string): Probe {
  if (specVersion === DRAFT_PROTOCOL_VERSION) {
    // Reuse the shared `_meta` envelope builder so the stateless probe carries
    // exactly the required keys a strictly-conformant server expects.
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: withRequestMeta({}, specVersion)
    };
  }
  const clientInfo = { name: 'conformance-dpop-server-test', version: '1.0.0' };
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: specVersion, capabilities: {}, clientInfo }
  };
}

interface Response {
  statusCode: number;
  wwwAuthenticate: string;
  dpopNonce: string | undefined;
  /** The server's `Date` header as epoch seconds, if present (RFC 9110 §6.6.1). */
  date: number | undefined;
}

function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}

// A DPoP failure MUST be a 401 carrying a WWW-Authenticate: DPoP challenge
// (SEP-1932 / RFC 9449 §7.1) — not merely "some 4xx", so that an unrelated
// MCP-layer rejection cannot vacuously pass a negative check.
//
// The header may advertise several challenges (e.g. `Bearer ..., DPoP ...`),
// so match a `DPoP` auth-scheme token at the start or after a comma rather
// than requiring the header to *begin* with it (RFC 9110 §11.6.1).
function hasDpopChallenge(wwwAuthenticate: string): boolean {
  return /(?:^|,)\s*dpop(?:\s|$|,)/i.test(wwwAuthenticate);
}

function properlyRejected(res: Response): boolean {
  return res.statusCode === 401 && hasDpopChallenge(res.wwwAuthenticate);
}

// A `use_dpop_nonce` challenge means the server is demanding a (different) nonce
// before it will look at the proof. Negative probes carry the held nonce, so
// such a 401 means the server did not accept that nonce (it rotated or
// single-uses it, or wants a fresh one) — the rejection is about the nonce
// lifetime, NOT the injected defect, so it cannot be attributed to the defect
// and must not count as a proper rejection.
function isNonceChallenge(res: Response): boolean {
  return (
    res.statusCode === 401 &&
    res.wwwAuthenticate.toLowerCase().includes('use_dpop_nonce')
  );
}

function dpopCheck(
  id: string,
  name: string,
  description: string,
  status: ConformanceCheck['status'],
  errorMessage?: string,
  details?: Record<string, unknown>
): ConformanceCheck {
  return {
    id,
    name,
    description,
    timestamp: new Date().toISOString(),
    specReferences: SPEC_REFERENCES,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    ...(details ? { details } : {})
  };
}

// Reason a rejection check cannot be attributed when the baseline is refused.
function gateReason(caseLabel: unknown): string {
  return `server did not accept the valid baseline DPoP request, so a rejection of the ${String(caseLabel ?? 'malformed')} case cannot be distinguished from a server that rejects everything`;
}

// A probe that throws (proof build / transport error) is a genuine FAILURE when
// the baseline was accepted, but — like the gated checks — not attributable when
// it wasn't, so the catch mirrors the gate rather than emitting a raw FAILURE.
function probeErrorCheck(
  positiveAccepted: boolean,
  id: string,
  name: string,
  description: string,
  caseLabel: string,
  error: unknown
): ConformanceCheck {
  return positiveAccepted
    ? dpopCheck(id, name, description, 'FAILURE', String(error), {
        case: caseLabel
      })
    : untestableCheck(
        id,
        name,
        description,
        gateReason(caseLabel),
        SPEC_REFERENCES
      );
}

// Build a check that passes when the server properly rejected a malformed
// request (401 + DPoP challenge) and fails otherwise.
//
// Gated on the positive baseline: a server that refuses even a valid DPoP
// request would 401 every negative probe too, making these checks pass
// vacuously — so when `positiveAccepted` is false we report them notTestable
// (#248) rather than SUCCESS. `predicate` lets a case relax what counts as a
// proper rejection (e.g. the Bearer-scheme case, where no DPoP challenge is
// required).
function rejectionCheck(
  positiveAccepted: boolean,
  id: string,
  name: string,
  description: string,
  res: Response,
  details: Record<string, unknown>,
  predicate: (res: Response) => boolean = properlyRejected
): ConformanceCheck {
  if (!positiveAccepted) {
    return untestableCheck(
      id,
      name,
      description,
      gateReason(details.case),
      SPEC_REFERENCES
    );
  }
  if (isNonceChallenge(res)) {
    return untestableCheck(
      id,
      name,
      description,
      `server answered with a DPoP nonce challenge (use_dpop_nonce) despite the probe carrying the held nonce, so this rejection is about the nonce (rotated/stale/single-use) and cannot be attributed to the ${String(details.case ?? 'injected')} defect`,
      SPEC_REFERENCES
    );
  }
  const ok = predicate(res);
  return dpopCheck(
    id,
    name,
    description,
    ok ? 'SUCCESS' : 'FAILURE',
    ok
      ? undefined
      : `Expected the server to reject this request, got ${res.statusCode} / "${res.wwwAuthenticate}"`,
    {
      ...details,
      statusCode: res.statusCode,
      wwwAuthenticate: res.wwwAuthenticate
    }
  );
}

async function resolveIssuer(): Promise<{
  issuerKey: TokenIssuerKey;
  issuer: string;
}> {
  const issuer =
    process.env.DPOP_ISSUER || 'https://conformance-dpop-issuer.example.com';
  const envJwk = process.env.DPOP_ISSUER_PRIVATE_JWK;
  if (envJwk) {
    const jwk = JSON.parse(envJwk);
    return {
      issuerKey: await importIssuerKey(jwk, jwk.alg || 'ES256'),
      issuer
    };
  }
  return { issuerKey: await generateIssuerKey(), issuer };
}

export class DPoPServerValidationScenario implements ClientScenario {
  name = 'auth/dpop-server-validation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test that an MCP server validates DPoP (RFC 9449) sender-constrained access tokens (SEP-1932).

The framework acts as a DPoP client: it presents a valid DPoP-bound access token
and proof (which a conformant server MUST accept) and a series of deliberately
malformed requests (which a conformant server MUST reject with HTTP 401 and a
\`WWW-Authenticate: DPoP\` challenge), following RFC 9449 §4.3.

Covers: proof validation per §4.3, the ±5-minute \`iat\` window, asymmetric-only
algorithms, the 401 challenge format, token audience validation under DPoP, and
(optionally) the server-provided nonce flow.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];

    const { issuerKey, issuer } = await resolveIssuer();
    const audience = serverUrl;
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      issuer,
      audience,
      jkt: kp.thumbprint
    });

    // The server-provided nonce (RFC 9449 §8/§9), if the server requires one.
    // `send` refreshes it from every response's DPoP-Nonce header (newest wins,
    // RFC 9449 §8.2), and the local `buildDpopProof` wrapper folds the current
    // value into every subsequent proof — including the negatives — so a server
    // that checks the nonce first still evaluates the injected defect rather
    // than merely re-challenging. Refreshing (vs capturing once) keeps this
    // correct against servers that rotate or single-use their nonces.
    let heldNonce: string | undefined;

    const send = async (
      authz: string,
      dpop: string | string[] | undefined
    ): Promise<Response> => {
      const probe = probeBody(specVersion);
      const base = buildStandardHeaders(probe.method, probe.params, {
        specVersion
      });
      const headers: Record<string, string | string[]> = {
        ...base,
        Authorization: authz
      };
      if (dpop !== undefined) headers['DPoP'] = dpop;
      const res = await request(serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(probe)
      });
      // Drain the body so the socket can be reused / freed.
      try {
        await res.body.text();
      } catch {
        /* ignore */
      }
      // undici may surface a repeated header as string[]; coalesce so challenge
      // matching sees every advertised scheme.
      const rawWww = res.headers['www-authenticate'];
      const wwwAuthenticate = Array.isArray(rawWww)
        ? rawWww.join(', ')
        : rawWww || '';
      const rawNonce = res.headers['dpop-nonce'];
      const dpopNonce = Array.isArray(rawNonce) ? rawNonce[0] : rawNonce;
      const rawDate = res.headers['date'];
      const dateStr = Array.isArray(rawDate) ? rawDate[0] : rawDate;
      const parsedDate = dateStr ? Date.parse(dateStr) : NaN;
      const date = Number.isNaN(parsedDate)
        ? undefined
        : Math.floor(parsedDate / 1000);
      // Newest-wins (RFC 9449 §8.2): carry the latest nonce into the next probe.
      if (dpopNonce) heldNonce = dpopNonce;
      return { statusCode: res.statusCode, wwwAuthenticate, dpopNonce, date };
    };

    const buildDpopProof = (
      opts: Parameters<typeof baseBuildDpopProof>[0]
    ): Promise<string> =>
      baseBuildDpopProof({
        ...opts,
        ...(heldNonce ? { nonce: heldNonce } : {})
      });

    const validProof = (): Promise<string> =>
      buildDpopProof({
        keyPair: kp,
        htm: 'POST',
        htu: serverUrl,
        accessToken: token
      });

    // Send a valid DPoP-bound request, transparently completing the nonce
    // handshake if the server demands one (RFC 9449 §9): a server that requires
    // a nonce answers the first (nonce-less) proof with 401 use_dpop_nonce +
    // DPoP-Nonce, so we capture the nonce and retry once before judging whether
    // it accepts a valid request (and reuse the nonce for the negatives).
    const acceptValid = async (): Promise<Response> => {
      const first = await send(`DPoP ${token}`, await validProof());
      if (
        first.statusCode === 401 &&
        first.dpopNonce &&
        first.wwwAuthenticate.includes('use_dpop_nonce')
      ) {
        // `send` has already refreshed heldNonce from the challenge response,
        // so the retry's proof carries it.
        return send(`DPoP ${token}`, await validProof());
      }
      return first;
    };

    // ---- Positive: a valid DPoP-bound request is accepted ----
    // Whether this succeeds gates every rejection check below (#248): if the
    // server refuses a valid request, a 401 on a malformed one proves nothing.
    // Also anchor iat probes to the server's own clock (its `Date` header) so
    // the ±5-minute boundary is measured against the clock the server validates
    // against, immune to framework↔server skew.
    let positiveAccepted = false;
    let serverClockOffset = 0;
    try {
      const res = await acceptValid();
      if (res.date !== undefined) {
        serverClockOffset = res.date - Math.floor(Date.now() / 1000);
      }
      positiveAccepted = isAccepted(res.statusCode);
      checks.push(
        dpopCheck(
          'sep-1932-server-validate-proof',
          'AcceptsValidProof',
          'Server accepts a valid DPoP-bound access token and proof',
          positiveAccepted ? 'SUCCESS' : 'FAILURE',
          positiveAccepted ? undefined : `Expected 2xx, got ${res.statusCode}`,
          { case: 'valid', statusCode: res.statusCode }
        )
      );
    } catch (e) {
      checks.push(
        dpopCheck(
          'sep-1932-server-validate-proof',
          'AcceptsValidProof',
          'Server accepts a valid DPoP-bound access token and proof',
          'FAILURE',
          String(e),
          { case: 'valid' }
        )
      );
    }

    // ---- Negative §4.3 variants: each malformed proof must be rejected ----
    // `buildDpop` is a thunk so a failure minting one proof isolates to that
    // case (caught below) instead of aborting the whole battery. `predicate`
    // and `description` override the default (401 + DPoP challenge) where a
    // case is judged differently.
    const negatives: Array<{
      case: string;
      name: string;
      authz: string;
      buildDpop: () => Promise<string | string[]>;
      predicate?: (res: Response) => boolean;
      description?: string;
    }> = [
      {
        case: 'tampered-signature',
        name: 'RejectsTamperedSignature',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            tamperSignature: true
          })
      },
      {
        case: 'missing-jti',
        name: 'RejectsMissingJti',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            omit: ['jti']
          })
      },
      {
        case: 'wrong-typ',
        name: 'RejectsWrongTyp',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            typ: 'jwt'
          })
      },
      {
        case: 'htu-mismatch',
        name: 'RejectsHtuMismatch',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: 'https://wrong.example.com/mcp',
            accessToken: token
          })
      },
      {
        case: 'htm-mismatch',
        name: 'RejectsHtmMismatch',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'GET',
            htu: serverUrl,
            accessToken: token
          })
      },
      {
        case: 'private-key-in-jwk',
        name: 'RejectsPrivateKeyInJwk',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            embedPrivateKey: true
          })
      },
      {
        case: 'wrong-ath',
        name: 'RejectsWrongAth',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            athOverride: 'not-the-right-hash'
          })
      },
      {
        // A DPoP-bound token presented under the Bearer scheme MUST NOT be
        // accepted, but the server need not answer with a DPoP challenge (it may
        // treat it as a Bearer failure) — so accept any non-2xx as a rejection.
        case: 'bearer-scheme',
        name: 'RejectsBearerScheme',
        authz: `Bearer ${token}`,
        buildDpop: () => validProof(),
        predicate: (res) => !isAccepted(res.statusCode),
        description:
          'Server does not accept a DPoP-bound token presented under the Bearer scheme'
      },
      {
        case: 'duplicate-dpop-header',
        name: 'RejectsDuplicateDpopHeader',
        authz: `DPoP ${token}`,
        buildDpop: async () => [await validProof(), await validProof()]
      },
      {
        case: 'missing-htm',
        name: 'RejectsMissingHtm',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            omit: ['htm']
          })
      },
      {
        case: 'missing-htu',
        name: 'RejectsMissingHtu',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            omit: ['htu']
          })
      },
      {
        case: 'missing-iat',
        name: 'RejectsMissingIat',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            omit: ['iat']
          })
      },
      {
        case: 'missing-jwk',
        name: 'RejectsMissingJwk',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            omit: ['jwk']
          })
      },
      {
        // Token is presented (Authorization: DPoP ...) but the proof carries no
        // ath claim — RFC 9449 §4.3 step 12a requires it.
        case: 'ath-absent',
        name: 'RejectsAthAbsent',
        authz: `DPoP ${token}`,
        buildDpop: () =>
          buildDpopProof({ keyPair: kp, htm: 'POST', htu: serverUrl })
      },
      {
        case: 'malformed-not-a-jwt',
        name: 'RejectsMalformedProof',
        authz: `DPoP ${token}`,
        buildDpop: () => Promise.resolve('this-is-not-a-jwt')
      }
    ];

    for (const n of negatives) {
      const description =
        n.description ?? `Server rejects a DPoP request with defect: ${n.case}`;
      try {
        const dpop = await n.buildDpop();
        const res = await send(n.authz, dpop);
        checks.push(
          rejectionCheck(
            positiveAccepted,
            'sep-1932-server-validate-proof',
            n.name,
            description,
            res,
            { case: n.case },
            n.predicate
          )
        );
      } catch (e) {
        checks.push(
          probeErrorCheck(
            positiveAccepted,
            'sep-1932-server-validate-proof',
            n.name,
            description,
            n.case,
            e
          )
        );
      }
    }

    // ---- cnf.jkt mismatch (token bound to a foreign key) ----
    try {
      const foreign = await generateDpopKeyPair();
      const mismatchToken = await mintDpopBoundToken({
        issuerKey,
        issuer,
        audience,
        jkt: kp.thumbprint,
        jktOverride: foreign.thumbprint
      });
      const proof = await buildDpopProof({
        keyPair: kp,
        htm: 'POST',
        htu: serverUrl,
        accessToken: mismatchToken
      });
      const res = await send(`DPoP ${mismatchToken}`, proof);
      checks.push(
        rejectionCheck(
          positiveAccepted,
          'sep-1932-server-validate-proof',
          'RejectsCnfJktMismatch',
          'Server rejects a token whose cnf.jkt does not match the proof key',
          res,
          { case: 'cnf-jkt-mismatch' }
        )
      );
    } catch (e) {
      checks.push(
        probeErrorCheck(
          positiveAccepted,
          'sep-1932-server-validate-proof',
          'RejectsCnfJktMismatch',
          'Server rejects a token whose cnf.jkt does not match the proof key',
          'cnf-jkt-mismatch',
          e
        )
      );
    }

    // ---- iat acceptance window ----
    // Probes sit just outside the ±5-minute window (±300 s), ±303 s on both
    // sides. The 3 s margin absorbs two sources of ±1 s error that a bare ±301
    // would not: the whole-second `Date` header makes `serverClockOffset`
    // quantized to ±1 s, and `iat` is whole-seconds and drifts ~1 s toward "now"
    // in transit. At ±301 either could pull the probe onto the ±300 boundary and
    // be false-accepted; ±303 stays safely outside for a conformant server while
    // still being well inside a rejection for any sane implementation.
    for (const { label, name, iatDelta } of [
      { label: 'stale', name: 'RejectsStaleIat', iatDelta: -303 },
      { label: 'future', name: 'RejectsFutureIat', iatDelta: 303 }
    ]) {
      const description = `Server rejects a proof whose iat is ${label} — just outside the ±5-minute window (RFC 9449 §4.3 / SEP-1932)`;
      try {
        const iat =
          Math.floor(Date.now() / 1000) + serverClockOffset + iatDelta;
        const proof = await buildDpopProof({
          keyPair: kp,
          htm: 'POST',
          htu: serverUrl,
          accessToken: token,
          iat
        });
        const res = await send(`DPoP ${token}`, proof);
        checks.push(
          rejectionCheck(
            positiveAccepted,
            'sep-1932-server-iat-window',
            name,
            description,
            res,
            { case: `iat-${label}` }
          )
        );
      } catch (e) {
        checks.push(
          probeErrorCheck(
            positiveAccepted,
            'sep-1932-server-iat-window',
            name,
            description,
            `iat-${label}`,
            e
          )
        );
      }
    }

    // ---- asymmetric-only algorithm ----
    for (const { label, name, opt } of [
      {
        label: 'none',
        name: 'RejectsAlgNone',
        opt: { unsigned: true } as const
      },
      {
        label: 'symmetric',
        name: 'RejectsAlgSymmetric',
        opt: { symmetric: true } as const
      }
    ]) {
      try {
        const proof = await buildDpopProof({
          keyPair: kp,
          htm: 'POST',
          htu: serverUrl,
          accessToken: token,
          ...opt
        });
        const res = await send(`DPoP ${token}`, proof);
        checks.push(
          rejectionCheck(
            positiveAccepted,
            'sep-1932-asymmetric-alg-only',
            name,
            `Server rejects a proof signed with a non-asymmetric algorithm (${label})`,
            res,
            { case: `alg-${label}` }
          )
        );
      } catch (e) {
        checks.push(
          probeErrorCheck(
            positiveAccepted,
            'sep-1932-asymmetric-alg-only',
            name,
            `Server rejects a proof signed with a non-asymmetric algorithm (${label})`,
            `alg-${label}`,
            e
          )
        );
      }
    }

    // ---- token audience validation under DPoP ----
    try {
      const wrongAudToken = await mintDpopBoundToken({
        issuerKey,
        issuer,
        audience: 'https://not-this-server.example.com/mcp',
        jkt: kp.thumbprint
      });
      const proof = await buildDpopProof({
        keyPair: kp,
        htm: 'POST',
        htu: serverUrl,
        accessToken: wrongAudToken
      });
      const res = await send(`DPoP ${wrongAudToken}`, proof);
      checks.push(
        rejectionCheck(
          positiveAccepted,
          'sep-1932-server-audience-validation',
          'RejectsWrongAudience',
          'Server rejects an access token whose audience is not this server, even with a valid proof',
          res,
          { case: 'wrong-audience' }
        )
      );
    } catch (e) {
      checks.push(
        probeErrorCheck(
          positiveAccepted,
          'sep-1932-server-audience-validation',
          'RejectsWrongAudience',
          'Server rejects an access token whose audience is not this server, even with a valid proof',
          'wrong-audience',
          e
        )
      );
    }

    // ---- 401 + WWW-Authenticate challenge format (on a known-bad request) ----
    const challengeDesc =
      'On validation failure the server responds 401 with a WWW-Authenticate: DPoP challenge';
    if (!positiveAccepted) {
      // A server that 401s everything trivially "passes" this — can't attribute
      // the challenge to a validation failure, so report it notTestable (#248).
      checks.push(
        untestableCheck(
          'sep-1932-server-reject-401',
          'RejectsWith401Challenge',
          challengeDesc,
          gateReason('challenge-format'),
          SPEC_REFERENCES
        )
      );
    } else {
      try {
        const tampered = await buildDpopProof({
          keyPair: kp,
          htm: 'POST',
          htu: serverUrl,
          accessToken: token,
          tamperSignature: true
        });
        const res = await send(`DPoP ${token}`, tampered);
        if (isNonceChallenge(res)) {
          checks.push(
            untestableCheck(
              'sep-1932-server-reject-401',
              'RejectsWith401Challenge',
              challengeDesc,
              'server answered with a DPoP nonce challenge (use_dpop_nonce), so this 401 cannot be attributed to the validation failure',
              SPEC_REFERENCES
            )
          );
        } else {
          const ok = properlyRejected(res);
          checks.push(
            dpopCheck(
              'sep-1932-server-reject-401',
              'RejectsWith401Challenge',
              challengeDesc,
              ok ? 'SUCCESS' : 'FAILURE',
              ok
                ? undefined
                : `Expected 401 + WWW-Authenticate: DPoP, got ${res.statusCode} / "${res.wwwAuthenticate}"`,
              {
                statusCode: res.statusCode,
                wwwAuthenticate: res.wwwAuthenticate
              }
            )
          );
        }
      } catch (e) {
        checks.push(
          dpopCheck(
            'sep-1932-server-reject-401',
            'RejectsWith401Challenge',
            challengeDesc,
            'FAILURE',
            String(e)
          )
        );
      }
    }

    // ---- server-provided nonce (SHOULD / WARNING) — only if the server uses it ----
    // This section manages the nonce explicitly, so it builds proofs with the
    // raw `baseBuildDpopProof` (not the held-nonce-injecting wrapper): the
    // detection probe MUST be nonce-less to observe whether the server challenges.
    try {
      const first = await send(
        `DPoP ${token}`,
        await baseBuildDpopProof({
          keyPair: kp,
          htm: 'POST',
          htu: serverUrl,
          accessToken: token
        })
      );
      const requiresNonce =
        first.statusCode === 401 &&
        first.wwwAuthenticate.includes('use_dpop_nonce');
      if (!requiresNonce) {
        checks.push(
          dpopCheck(
            'sep-1932-server-nonce',
            'NonceFlow',
            'Server-provided nonce flow (optional; server did not request a nonce)',
            'SKIPPED',
            undefined,
            { reason: 'server does not require a DPoP nonce' }
          )
        );
      } else if (!first.dpopNonce) {
        checks.push(
          dpopCheck(
            'sep-1932-server-nonce',
            'NonceFlow',
            'Server issues use_dpop_nonce + DPoP-Nonce, accepts the matching-nonce retry, and rejects a wrong nonce',
            'WARNING',
            'use_dpop_nonce returned without a DPoP-Nonce header'
          )
        );
      } else {
        const retry = await send(
          `DPoP ${token}`,
          await baseBuildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            nonce: first.dpopNonce
          })
        );
        // A conformant nonce server MUST also reject a WRONG nonce
        // (RFC 9449 §4.3 step 10), else the nonce adds no replay protection.
        const wrong = await send(
          `DPoP ${token}`,
          await baseBuildDpopProof({
            keyPair: kp,
            htm: 'POST',
            htu: serverUrl,
            accessToken: token,
            nonce: 'definitely-not-the-server-nonce'
          })
        );
        const ok = isAccepted(retry.statusCode) && properlyRejected(wrong);
        // SHOULD-level: satisfied → SUCCESS; partial/buggy nonce impl → WARNING.
        checks.push(
          dpopCheck(
            'sep-1932-server-nonce',
            'NonceFlow',
            'Server issues use_dpop_nonce + DPoP-Nonce, accepts the matching-nonce retry, and rejects a wrong nonce',
            ok ? 'SUCCESS' : 'WARNING',
            ok
              ? undefined
              : `Nonce flow incomplete: matching-retry=${retry.statusCode}, wrong-nonce=${wrong.statusCode}`,
            {
              nonce: first.dpopNonce,
              retryStatus: retry.statusCode,
              wrongNonceStatus: wrong.statusCode
            }
          )
        );
      }
    } catch (e) {
      checks.push(
        dpopCheck(
          'sep-1932-server-nonce',
          'NonceFlow',
          'Server issues use_dpop_nonce + DPoP-Nonce, accepts the matching-nonce retry, and rejects a wrong nonce',
          'WARNING',
          String(e)
        )
      );
    }

    return checks;
  }
}
