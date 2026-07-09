import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'undici';
import { createHash, randomBytes } from 'crypto';
import {
  generateDpopKeyPair,
  buildDpopProof
} from '../../../../src/scenarios/client/auth/helpers/dpopProof';
import { logger } from './logger';

/**
 * Shared DPoP client flow (SEP-1932 / RFC 9449). Acquires a DPoP-bound access
 * token via the authorization_code + PKCE grant (with a DPoP proof at the token
 * endpoint), then opens an MCP session presenting the token to the resource.
 *
 * The OAuth flow is hand-rolled rather than reusing ConformanceOAuthProvider /
 * withOAuthRetry because the SDK's OAuth provider offers no hook to attach a
 * DPoP proof to the token-endpoint request, which is required to obtain a bound
 * token. The MCP session itself does use the SDK Client (via a fetch wrapper).
 *
 * Parameterized so the compliant client and the deliberately-broken variants
 * differ by exactly one behaviour:
 *  - `scheme: 'Bearer'`           → fails sep-1932-client-dpop-auth-scheme
 *  - `freshProofPerRequest:false` → reuses one proof, fails sep-1932-client-fresh-proof
 *  - `sendTokenRequestProof:false`→ omits the token-endpoint proof, so the AS
 *    issues an unbound Bearer token; fails sep-1932-client-token-request-proof
 *    (and, downstream, the resource binding check, since the token isn't bound)
 *  - `handleAsNonce:false`        → ignores the token endpoint's `use_dpop_nonce`
 *    challenge (RFC 9449 §8); fails sep-1932-client-as-nonce
 *  - `handleRsNonce:false`        → ignores the MCP server's `use_dpop_nonce`
 *    challenge (RFC 9449 §9); fails sep-1932-client-rs-nonce
 */
export interface DpopClientOptions {
  scheme: 'DPoP' | 'Bearer';
  freshProofPerRequest: boolean;
  sendTokenRequestProof: boolean;
  /** Retry the token request with the AS-supplied nonce on a use_dpop_nonce challenge (RFC 9449 §8). */
  handleAsNonce: boolean;
  /** Retry an MCP request with the server-supplied nonce on a use_dpop_nonce challenge (RFC 9449 §9). */
  handleRsNonce: boolean;
}

const REDIRECT_URI = 'http://127.0.0.1:9876/callback';

export async function runDpopClient(
  serverUrl: string,
  options: DpopClientOptions
): Promise<void> {
  const keyPair = await generateDpopKeyPair();

  // 1. Discover the authorization server via Protected Resource Metadata.
  const prmUrl = new URL(
    '/.well-known/oauth-protected-resource/mcp',
    serverUrl
  );
  const prm = await (await fetch(prmUrl.toString())).json();
  const authServerUrl: string = prm.authorization_servers[0];
  // RFC 8707 resource indicator — sent in both the authorization request and
  // the token request, per the MCP authorization spec.
  const resource: string = prm.resource;

  // 2. Authorization server metadata.
  const asMeta = await (
    await fetch(
      new URL(
        '/.well-known/oauth-authorization-server',
        authServerUrl
      ).toString()
    )
  ).json();
  const authorizationEndpoint: string = asMeta.authorization_endpoint;
  const tokenEndpoint: string = asMeta.token_endpoint;
  const registrationEndpoint: string = asMeta.registration_endpoint;

  // 3. Dynamic client registration.
  const reg = await (
    await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'conformance-dpop-client',
        redirect_uris: [REDIRECT_URI],
        application_type: 'native'
      })
    })
  ).json();
  const clientId: string = reg.client_id;

  // 4. Authorization request (PKCE). The test AS redirects straight to the
  // redirect_uri, so read the code from the Location header (no callback needed).
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  const authorizeUrl = `${authorizationEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    state,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource
  }).toString()}`;
  const authorizeResponse = await request(authorizeUrl, { method: 'GET' });
  await authorizeResponse.body.text().catch(() => undefined);
  const location = authorizeResponse.headers['location'];
  const locationStr = Array.isArray(location) ? location[0] : location;
  if (!locationStr) {
    throw new Error('Authorization endpoint did not redirect with a code');
  }
  const callbackParams = new URL(locationStr).searchParams;
  const code = callbackParams.get('code');
  if (!code) throw new Error('No authorization code in redirect');
  // CSRF binding: the callback must echo our state (OAuth 2.1 §7.1).
  if (callbackParams.get('state') !== state) {
    throw new Error('Authorization response state does not match the request');
  }
  // RFC 9207: when the AS returns iss, it must equal the metadata issuer.
  const callbackIss = callbackParams.get('iss');
  if (callbackIss !== null && callbackIss !== asMeta.issuer) {
    throw new Error(
      `Authorization response iss "${callbackIss}" does not match the metadata issuer "${asMeta.issuer}"`
    );
  }

  // 5. Token request with a DPoP proof → DPoP-bound access token. The broken
  // `sendTokenRequestProof:false` variant omits the proof, so the AS issues an
  // unbound Bearer token instead.
  const tokenReqBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
    client_id: clientId,
    resource
  }).toString();
  const requestToken = async (nonce?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded'
    };
    if (options.sendTokenRequestProof) {
      headers.dpop = await buildDpopProof({
        keyPair,
        htm: 'POST',
        // RFC 9449 §4.2: htu carries no query/fragment (the token endpoint URL
        // may legally have a query, so strip it here).
        htu: stripQuery(tokenEndpoint),
        ...(nonce ? { nonce } : {})
      });
    }
    return fetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body: tokenReqBody
    });
  };
  let tokenResponse = await requestToken();
  // RFC 9449 §8: the AS may answer with `use_dpop_nonce` (HTTP 400 + DPoP-Nonce);
  // a conformant client retries the token request with the supplied nonce. Match
  // on the `use_dpop_nonce` error code (not merely any 400 carrying a nonce), so
  // an unrelated error (e.g. invalid_grant) that an AS proactively decorates with
  // a DPoP-Nonce header does not burn the retry and mask the real failure —
  // consistent with the resource-side check below.
  const asNonce = tokenResponse.headers.get('DPoP-Nonce');
  if (tokenResponse.status === 400 && asNonce && options.handleAsNonce) {
    const challenge = await tokenResponse
      .clone()
      .json()
      .catch(() => ({}) as { error?: string });
    if (challenge?.error === 'use_dpop_nonce') {
      tokenResponse = await requestToken(asNonce);
    }
  }
  if (!tokenResponse.ok) {
    // Surface the OAuth error body — error_description carries the actionable
    // detail (e.g. which DPoP proof claim the AS rejected).
    const body = await tokenResponse
      .json()
      .catch(() => ({}) as { error?: string; error_description?: string });
    const detail = [body.error, body.error_description]
      .filter(Boolean)
      .join(': ');
    throw new Error(
      `Token request failed: HTTP ${tokenResponse.status}${detail ? ` (${detail})` : ''}`
    );
  }
  const tokenBody = await tokenResponse.json();
  const accessToken: string = tokenBody.access_token;
  logger.debug(`Obtained ${tokenBody.token_type} access token`);

  // 6. MCP session — present the token to the resource with a per-request proof.
  // On a `use_dpop_nonce` challenge (RFC 9449 §9) a conformant client retries
  // with the server-supplied nonce embedded in the proof, and carries it on
  // subsequent requests.
  const mcpUrl = `${serverUrl}`;
  let reusableProof: string | undefined;
  let rsNonce: string | undefined;
  const dpopFetch = async (
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const method = (init?.method ?? 'POST').toUpperCase();
    const htu = stripQuery(
      typeof input === 'string' ? input : input.toString()
    );
    const attempt = async (): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `${options.scheme} ${accessToken}`);
      let proof: string;
      if (options.freshProofPerRequest || !reusableProof) {
        proof = await buildDpopProof({
          keyPair,
          htm: method,
          htu,
          accessToken,
          ...(rsNonce ? { nonce: rsNonce } : {})
        });
        if (!options.freshProofPerRequest) reusableProof = proof;
      } else {
        proof = reusableProof;
      }
      headers.set('DPoP', proof);
      return fetch(input, { ...init, headers });
    };
    let res = await attempt();
    const nonce = res.headers.get('DPoP-Nonce');
    if (
      res.status === 401 &&
      nonce &&
      options.handleRsNonce &&
      (res.headers.get('WWW-Authenticate') ?? '').includes('use_dpop_nonce')
    ) {
      rsNonce = nonce;
      reusableProof = undefined; // rebuild the proof carrying the nonce
      res = await attempt();
    }
    return res;
  };

  const client = new Client(
    { name: 'conformance-dpop-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: dpopFetch as typeof fetch
  });

  await client.connect(transport);
  logger.debug('Connected to MCP server');
  await client.listTools();
  logger.debug('Listed tools');
  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Called tool');
  await transport.close();
}

function stripQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}
