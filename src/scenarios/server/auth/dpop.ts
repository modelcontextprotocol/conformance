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
  DRAFT_PROTOCOL_VERSION,
  type SpecReference
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

const DISCOVERY_REFERENCES: SpecReference[] = [
  ...SPEC_REFERENCES,
  SpecReferences.RFC_9728_METADATA,
  SpecReferences.RFC_9728_WWW_AUTHENTICATE
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
  /** `error` auth-param of the DPoP challenge, if that challenge carries one. */
  dpopError: string | undefined;
}

// Proof defects (§4.3) vs token defects (RFC 6750 `invalid_token`). `either`
// covers cases implementations reasonably report as either (key binding, and a
// DPoP-bound token presented as Bearer).
type ExpectedDpopError = 'invalid_dpop_proof' | 'invalid_token' | 'either';

interface ErrorObservation {
  case: string;
  expected: ExpectedDpopError;
  actual: string | undefined;
  attributable: boolean;
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

// RFC 6750 §3 (Bearer) / RFC 9449 §7.1 (DPoP): a scheme token at the start of
// the header or after a comma. Used by the Bearer-downgrade probe, which
// accepts either challenge — the server may treat the request as a Bearer
// failure or as a DPoP presentation error.
function hasBearerOrDpopChallenge(wwwAuthenticate: string): boolean {
  return /(?:^|,)\s*(?:bearer|dpop)(?:\s|$|,)/i.test(wwwAuthenticate);
}

// RFC 9110 token. Auth-params are `token "=" ( token / quoted-string )`; a new
// challenge is a token that is NOT followed by "=" (RFC 9110 §11.6.1).
const AUTH_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;

function splitChallenges(header: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let quoted = false;
  while (i < header.length) {
    const ch = header[i];
    if (quoted) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') quoted = false;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      const rest = header.slice(i + 1).trimStart();
      const token = AUTH_TOKEN.exec(rest);
      const after = token ? rest.slice(token[0].length).trimStart() : '';
      if (token && !after.startsWith('=')) {
        parts.push(header.slice(start, i));
        start = i + 1;
      }
    }
    i++;
  }
  parts.push(header.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function readAuthParam(params: string, name: string): string | undefined {
  let i = 0;
  while (i < params.length) {
    while (i < params.length && /[\s,]/.test(params[i])) i++;
    if (i >= params.length) break;
    const token = AUTH_TOKEN.exec(params.slice(i));
    if (!token) break;
    i += token[0].length;
    while (i < params.length && params[i] === ' ') i++;
    if (params[i] !== '=') break;
    i++;
    while (i < params.length && params[i] === ' ') i++;
    let value = '';
    if (params[i] === '"') {
      i++;
      while (i < params.length && params[i] !== '"') {
        if (params[i] === '\\' && i + 1 < params.length) {
          value += params[i + 1];
          i += 2;
        } else {
          value += params[i];
          i++;
        }
      }
      if (params[i] === '"') i++;
    } else {
      const raw = AUTH_TOKEN.exec(params.slice(i));
      if (!raw) break;
      value = raw[0];
      i += value.length;
    }
    if (token[0].toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

/** `error` auth-param of the DPoP challenge. Quoted and unquoted values. */
export function dpopChallengeError(
  wwwAuthenticate: string
): string | undefined {
  for (const challenge of splitChallenges(wwwAuthenticate)) {
    const scheme = AUTH_TOKEN.exec(challenge);
    if (!scheme || scheme[0].toLowerCase() !== 'dpop') continue;
    return readAuthParam(challenge.slice(scheme[0].length), 'error');
  }
  return undefined;
}

function errorCodeMatches(
  expected: ExpectedDpopError,
  actual: string | undefined
): boolean {
  if (!actual) return false;
  if (expected === 'either') {
    return actual === 'invalid_dpop_proof' || actual === 'invalid_token';
  }
  return actual === expected;
}

function properlyRejected(res: Response): boolean {
  return res.statusCode === 401 && hasDpopChallenge(res.wwwAuthenticate);
}

function bearerSchemeRejected(res: Response): boolean {
  return (
    res.statusCode === 401 && hasBearerOrDpopChallenge(res.wwwAuthenticate)
  );
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
  details?: Record<string, unknown>,
  specReferences: SpecReference[] = SPEC_REFERENCES
): ConformanceCheck {
  return {
    id,
    name,
    description,
    timestamp: new Date().toISOString(),
    specReferences,
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
// (#248) rather than SUCCESS. `predicate` lets a case change what counts as a
// proper rejection (e.g. the Bearer-scheme case, which accepts a Bearer or
// DPoP challenge rather than requiring DPoP specifically).
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

const ADVERTISES_ID = 'sep-1932-server-advertises-dpop';
const ADVERTISES_NAME = 'AdvertisesDpop';
const ADVERTISES_DESC =
  'An unauthenticated request is answered with HTTP 401 and a DPoP challenge that includes an algs parameter (RFC 9449 §7.1)';

const PRM_ID = 'sep-1932-server-prm-dpop';
const PRM_NAME = 'PrmDpop';
const PRM_DESC =
  'Protected resource metadata advertises dpop_signing_alg_values_supported (asymmetric algorithms only) and dpop_bound_access_tokens_required (RFC 9728 §2)';

const CONSISTENCY_ID = 'sep-1932-server-prm-consistency';
const CONSISTENCY_NAME = 'PrmConsistency';
const CONSISTENCY_DESC =
  'The server rejects an unbound Bearer token when protected resource metadata says DPoP is required, and advertises that requirement when it enforces DPoP';

type PrmSource = 'resource_metadata' | 'well-known-path' | 'well-known-root';

interface PrmDocument {
  doc: Record<string, unknown>;
  source: PrmSource;
  url: string;
}

/** Path-based well-known URL, then the root one (RFC 9728 §3.1, MCP discovery order). */
export function protectedResourceMetadataFallbacks(resourceUrl: string): {
  pathBased: string;
  root: string;
} {
  const u = new URL(resourceUrl);
  // A resource at the origin has no path to insert. `pathname` is `/` there;
  // appending it would leave a trailing slash the well-known URL does not use.
  const path = u.pathname === '/' ? '' : u.pathname;
  return {
    pathBased: `${u.origin}/.well-known/oauth-protected-resource${path}${u.search}`,
    root: `${u.origin}/.well-known/oauth-protected-resource`
  };
}

function dpopAuthParam(header: string, name: string): string | undefined {
  for (const challenge of splitChallenges(header)) {
    const scheme = AUTH_TOKEN.exec(challenge);
    if (!scheme || scheme[0].toLowerCase() !== 'dpop') continue;
    const value = readAuthParam(challenge.slice(scheme[0].length), name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** `resource_metadata` from the DPoP challenge, else from any sibling challenge. */
function resourceMetadataParam(header: string): string | undefined {
  const fromDpop = dpopAuthParam(header, 'resource_metadata');
  if (fromDpop !== undefined) return fromDpop;
  for (const challenge of splitChallenges(header)) {
    const scheme = AUTH_TOKEN.exec(challenge);
    if (!scheme) continue;
    const value = readAuthParam(
      challenge.slice(scheme[0].length),
      'resource_metadata'
    );
    if (value !== undefined) return value;
  }
  return undefined;
}

function forbiddenDpopAlgs(algs: unknown): string[] {
  const list = Array.isArray(algs) ? algs : [];
  return list.filter(
    (alg): alg is string =>
      typeof alg === 'string' &&
      (alg.toLowerCase() === 'none' || alg.toUpperCase().startsWith('HS'))
  );
}

async function fetchJsonDocument(
  url: string
): Promise<Record<string, unknown> | undefined> {
  const res = await request(url, {
    method: 'GET',
    headers: { accept: 'application/json' }
  });
  let text = '';
  try {
    text = await res.body.text();
  } catch {
    return undefined;
  }
  if (res.statusCode < 200 || res.statusCode >= 300) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * RFC 9728 §5.1, then the MCP fallback order from the client discovery
 * scenarios: the `resource_metadata` URL when the challenge carries one,
 * otherwise the path-based well-known URL, otherwise the root one. A
 * `resource_metadata` URL that does not yield a document is not replaced by
 * a different well-known document.
 */
async function discoverProtectedResourceMetadata(
  resourceUrl: string,
  resourceMetadata: string | undefined
): Promise<PrmDocument | { reason: string }> {
  if (resourceMetadata !== undefined && resourceMetadata.length > 0) {
    let absolute: string;
    try {
      absolute = new URL(resourceMetadata, resourceUrl).href;
    } catch {
      return {
        reason: `resource_metadata parameter is not a URL (${resourceMetadata})`
      };
    }
    const doc = await fetchJsonDocument(absolute);
    if (!doc) {
      return {
        reason: `protected resource metadata advertised at ${absolute} was unreachable or was not a JSON object`
      };
    }
    return { doc, source: 'resource_metadata', url: absolute };
  }

  const { pathBased, root } = protectedResourceMetadataFallbacks(resourceUrl);
  const candidates: Array<{ source: PrmSource; url: string }> =
    pathBased === root
      ? [{ source: 'well-known-root', url: root }]
      : [
          { source: 'well-known-path', url: pathBased },
          { source: 'well-known-root', url: root }
        ];
  for (const candidate of candidates) {
    const doc = await fetchJsonDocument(candidate.url);
    if (doc) return { doc, source: candidate.source, url: candidate.url };
  }
  return {
    reason:
      'protected resource metadata was not found at the path-based well-known URL or the root well-known URL'
  };
}

function gradeAdvertises(res: Response): ConformanceCheck {
  const challenged =
    res.statusCode === 401 && hasDpopChallenge(res.wwwAuthenticate);
  const algs = dpopAuthParam(res.wwwAuthenticate, 'algs');
  const details = {
    statusCode: res.statusCode,
    algs: algs ?? null,
    resourceMetadata: resourceMetadataParam(res.wwwAuthenticate) ?? null
  };
  if (!challenged) {
    return dpopCheck(
      ADVERTISES_ID,
      ADVERTISES_NAME,
      ADVERTISES_DESC,
      'FAILURE',
      `Unauthenticated request was not challenged with a DPoP scheme (HTTP ${res.statusCode})`,
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (!algs || algs.trim().length === 0) {
    return dpopCheck(
      ADVERTISES_ID,
      ADVERTISES_NAME,
      ADVERTISES_DESC,
      'WARNING',
      'DPoP challenge is missing the algs parameter',
      details,
      DISCOVERY_REFERENCES
    );
  }
  return dpopCheck(
    ADVERTISES_ID,
    ADVERTISES_NAME,
    ADVERTISES_DESC,
    'SUCCESS',
    undefined,
    details,
    DISCOVERY_REFERENCES
  );
}

function gradePrm(found: PrmDocument | { reason: string }): ConformanceCheck {
  if (!('doc' in found)) {
    return untestableCheck(
      PRM_ID,
      PRM_NAME,
      PRM_DESC,
      found.reason,
      DISCOVERY_REFERENCES
    );
  }
  const algs = found.doc.dpop_signing_alg_values_supported;
  const required = found.doc.dpop_bound_access_tokens_required;
  const forbidden = forbiddenDpopAlgs(algs);
  const algsOk =
    Array.isArray(algs) && algs.length > 0 && forbidden.length === 0;
  const requiredPresent = typeof required === 'boolean';
  const details: Record<string, unknown> = {
    source: found.source,
    url: found.url,
    dpop_signing_alg_values_supported: algs ?? null,
    dpop_bound_access_tokens_required: required ?? null,
    ...(forbidden.length > 0 ? { forbidden } : {})
  };
  if (forbidden.length > 0) {
    return dpopCheck(
      PRM_ID,
      PRM_NAME,
      PRM_DESC,
      'FAILURE',
      `dpop_signing_alg_values_supported MUST list only asymmetric algorithms; found non-asymmetric: ${forbidden.join(', ')}`,
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (!algsOk || !requiredPresent) {
    const missing = [
      ...(!algsOk ? ['dpop_signing_alg_values_supported'] : []),
      ...(!requiredPresent ? ['dpop_bound_access_tokens_required'] : [])
    ];
    return dpopCheck(
      PRM_ID,
      PRM_NAME,
      PRM_DESC,
      'FAILURE',
      `Protected resource metadata is missing ${missing.join(' and ')}`,
      details,
      DISCOVERY_REFERENCES
    );
  }
  return dpopCheck(
    PRM_ID,
    PRM_NAME,
    PRM_DESC,
    'SUCCESS',
    undefined,
    details,
    DISCOVERY_REFERENCES
  );
}

function gradeConsistency(
  saysRequired: boolean,
  res: Response
): ConformanceCheck {
  const accepted = isAccepted(res.statusCode);
  const rejected = res.statusCode === 401;
  const details = {
    dpop_bound_access_tokens_required: saysRequired,
    statusCode: res.statusCode
  };
  if (saysRequired && accepted) {
    return dpopCheck(
      CONSISTENCY_ID,
      CONSISTENCY_NAME,
      CONSISTENCY_DESC,
      'FAILURE',
      'Protected resource metadata says dpop_bound_access_tokens_required but the server accepted an unbound Bearer token',
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (saysRequired && rejected) {
    return dpopCheck(
      CONSISTENCY_ID,
      CONSISTENCY_NAME,
      CONSISTENCY_DESC,
      'SUCCESS',
      undefined,
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (saysRequired) {
    return dpopCheck(
      CONSISTENCY_ID,
      CONSISTENCY_NAME,
      CONSISTENCY_DESC,
      'FAILURE',
      `Expected the server to reject an unbound Bearer token with HTTP 401, got ${res.statusCode}`,
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (rejected) {
    return dpopCheck(
      CONSISTENCY_ID,
      CONSISTENCY_NAME,
      CONSISTENCY_DESC,
      'FAILURE',
      'server requires DPoP but does not advertise it',
      details,
      DISCOVERY_REFERENCES
    );
  }
  if (accepted) {
    return dpopCheck(
      CONSISTENCY_ID,
      CONSISTENCY_NAME,
      CONSISTENCY_DESC,
      'INFO',
      undefined,
      details,
      DISCOVERY_REFERENCES
    );
  }
  return dpopCheck(
    CONSISTENCY_ID,
    CONSISTENCY_NAME,
    CONSISTENCY_DESC,
    'WARNING',
    `Unbound Bearer token was neither accepted nor rejected with HTTP 401 (got ${res.statusCode})`,
    details,
    DISCOVERY_REFERENCES
  );
}

export class DPoPServerValidationScenario implements ClientScenario {
  name = 'auth/dpop-server-validation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test that an MCP server validates DPoP (RFC 9449) sender-constrained access tokens (SEP-1932).

The framework acts as a DPoP client: it presents a valid DPoP-bound access token
and proof (which a conformant server MUST accept) and a series of deliberately
malformed requests (which a conformant server MUST reject with HTTP 401 and a
\`WWW-Authenticate: DPoP\` challenge), following RFC 9449 §4.3.

Covers: proof validation per §4.3, the ±5-minute \`iat\` window,
asymmetric-only algorithms, the 401 challenge format, the §7.1 \`error\` code
(SHOULD), how an unauthenticated client learns that DPoP is required (the
challenge \`algs\` parameter and Protected Resource Metadata), token audience
validation under DPoP, and (optionally) the server-provided nonce flow.`;

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
    // correct against servers that ROTATE their nonce (each response carries the
    // next one). A strict single-use server that re-arms the nonce only via a
    // use_dpop_nonce challenge (not on ordinary rejections, which §8.2 doesn't
    // require) can still push alternate negatives to untestable — acceptable, as
    // those are correctly reported not-testable rather than mis-scored.
    let heldNonce: string | undefined;
    let positiveAccepted = false;

    const errorObservations: ErrorObservation[] = [];
    // A nonce challenge or a probe that threw is not a validation result, so it
    // is not scored. Absent and unexpected codes are scored later, once.
    const observeError = (
      caseName: string,
      expected: ExpectedDpopError,
      res: Response | undefined
    ): void => {
      errorObservations.push({
        case: caseName,
        expected,
        actual: res?.dpopError,
        attributable:
          positiveAccepted && res !== undefined && !isNonceChallenge(res)
      });
    };

    const readHttp = async (
      res: Awaited<ReturnType<typeof request>>
    ): Promise<Response> => {
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
      return {
        statusCode: res.statusCode,
        wwwAuthenticate,
        dpopNonce,
        date,
        dpopError: dpopChallengeError(wwwAuthenticate)
      };
    };

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
      return readHttp(res);
    };

    const sendUnauthenticated = async (): Promise<Response> => {
      const probe = probeBody(specVersion);
      const res = await request(serverUrl, {
        method: 'POST',
        headers: buildStandardHeaders(probe.method, probe.params, {
          specVersion
        }),
        body: JSON.stringify(probe)
      });
      return readHttp(res);
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

    // ---- Discovery: an unauthenticated client must be able to learn DPoP ----
    // Runs before the positive probe and is not gated on it: a server that
    // rejects a valid proof can still advertise DPoP on the 401.
    let saysDpopRequired = false;
    try {
      const unauth = await sendUnauthenticated();
      checks.push(gradeAdvertises(unauth));
      try {
        const found = await discoverProtectedResourceMetadata(
          serverUrl,
          resourceMetadataParam(unauth.wwwAuthenticate)
        );
        if ('doc' in found) {
          saysDpopRequired =
            found.doc.dpop_bound_access_tokens_required === true;
        }
        checks.push(gradePrm(found));
      } catch (e) {
        checks.push(
          untestableCheck(
            PRM_ID,
            PRM_NAME,
            PRM_DESC,
            `protected resource metadata request failed: ${String(e)}`,
            DISCOVERY_REFERENCES
          )
        );
      }
    } catch (e) {
      const reason = `unauthenticated probe failed: ${String(e)}`;
      checks.push(
        untestableCheck(
          ADVERTISES_ID,
          ADVERTISES_NAME,
          ADVERTISES_DESC,
          reason,
          DISCOVERY_REFERENCES
        )
      );
      checks.push(
        untestableCheck(
          PRM_ID,
          PRM_NAME,
          PRM_DESC,
          reason,
          DISCOVERY_REFERENCES
        )
      );
    }

    // ---- Positive: a valid DPoP-bound request is accepted ----
    // Whether this succeeds gates every rejection check below (#248): if the
    // server refuses a valid request, a 401 on a malformed one proves nothing.
    // Also anchor iat probes to the server's own clock (its `Date` header) so
    // the ±5-minute boundary is measured against the clock the server validates
    // against, immune to framework↔server skew.
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

    // ---- Consistency: advertised DPoP requirement matches enforcement ----
    // Gated on the positive baseline, same as the rejection battery: a server
    // that 401s everything would otherwise look like it correctly refuses an
    // unbound Bearer token.
    if (!positiveAccepted) {
      checks.push(
        untestableCheck(
          CONSISTENCY_ID,
          CONSISTENCY_NAME,
          CONSISTENCY_DESC,
          gateReason('unbound-bearer'),
          DISCOVERY_REFERENCES
        )
      );
    } else {
      try {
        const unbound = await mintDpopBoundToken({
          issuerKey,
          issuer,
          audience,
          jkt: kp.thumbprint,
          omitCnf: true
        });
        const unboundRes = await send(`Bearer ${unbound}`, undefined);
        checks.push(gradeConsistency(saysDpopRequired, unboundRes));
      } catch (e) {
        checks.push(
          dpopCheck(
            CONSISTENCY_ID,
            CONSISTENCY_NAME,
            CONSISTENCY_DESC,
            'FAILURE',
            String(e),
            { case: 'unbound-bearer' },
            DISCOVERY_REFERENCES
          )
        );
      }
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
      /** Defaults to invalid_dpop_proof (a §4.3 proof defect). */
      expectedError?: ExpectedDpopError;
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
        // accepted. Count only a real authentication rejection: 401 plus a
        // Bearer (RFC 6750 §3) or DPoP challenge. A 500/404 with no
        // WWW-Authenticate is not a rejection of the scheme.
        case: 'bearer-scheme',
        name: 'RejectsBearerScheme',
        authz: `Bearer ${token}`,
        buildDpop: () => validProof(),
        predicate: bearerSchemeRejected,
        expectedError: 'either',
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
      let res: Response | undefined;
      try {
        const dpop = await n.buildDpop();
        res = await send(n.authz, dpop);
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
      observeError(n.case, n.expectedError ?? 'invalid_dpop_proof', res);
    }

    // ---- cnf.jkt mismatch (token bound to a foreign key) ----
    // Key binding is a §4.3 step, but implementations reasonably report it as a
    // token problem, so either error code is accepted.
    {
      let res: Response | undefined;
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
        res = await send(`DPoP ${mismatchToken}`, proof);
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
      observeError('cnf-jkt-mismatch', 'either', res);
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
      let res: Response | undefined;
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
        res = await send(`DPoP ${token}`, proof);
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
      observeError(`iat-${label}`, 'invalid_dpop_proof', res);
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
      let res: Response | undefined;
      try {
        const proof = await buildDpopProof({
          keyPair: kp,
          htm: 'POST',
          htu: serverUrl,
          accessToken: token,
          ...opt
        });
        res = await send(`DPoP ${token}`, proof);
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
      observeError(`alg-${label}`, 'invalid_dpop_proof', res);
    }

    // ---- token audience validation under DPoP ----
    {
      let res: Response | undefined;
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
        res = await send(`DPoP ${wrongAudToken}`, proof);
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
      observeError('wrong-audience', 'invalid_token', res);
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

    // ---- §7.1 error code (SHOULD): one aggregate, MUST checks unchanged ----
    const errorCodeDesc =
      'Declined DPoP requests include an error parameter on the DPoP challenge naming the reason (RFC 9449 §7.1)';
    if (!positiveAccepted) {
      checks.push(
        untestableCheck(
          'sep-1932-server-error-code',
          'ReportsDpopErrorCode',
          errorCodeDesc,
          gateReason('error-code'),
          SPEC_REFERENCES,
          'WARNING'
        )
      );
    } else {
      const attributable = errorObservations.filter((o) => o.attributable);
      if (attributable.length === 0) {
        checks.push(
          untestableCheck(
            'sep-1932-server-error-code',
            'ReportsDpopErrorCode',
            errorCodeDesc,
            'no declined DPoP request could be attributed to its defect, so the error code cannot be checked',
            SPEC_REFERENCES,
            'WARNING'
          )
        );
      } else {
        const mismatches = attributable
          .filter((o) => !errorCodeMatches(o.expected, o.actual))
          .map((o) => ({
            case: o.case,
            expected: o.expected,
            actual: o.actual ?? null
          }));
        const ok = mismatches.length === 0;
        checks.push(
          dpopCheck(
            'sep-1932-server-error-code',
            'ReportsDpopErrorCode',
            errorCodeDesc,
            ok ? 'SUCCESS' : 'WARNING',
            ok
              ? undefined
              : `DPoP error code missing or unexpected: ${mismatches
                  .map(
                    (m) =>
                      `${m.case} expected ${m.expected} got ${m.actual ?? 'absent'}`
                  )
                  .join('; ')}`,
            { mismatches }
          )
        );
      }
    }

    return checks;
  }
}
