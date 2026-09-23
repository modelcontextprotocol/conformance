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
 *  - `sendDpopJkt:false`          → omits dpop_jkt on the authorization request;
 *    warns sep-1932-client-dpop-jkt (SEP-1932 / RFC 9449 §10)
 *  - `wrongDpopJkt:true`          → sends a dpop_jkt that does not match the
 *    token-request proof key; fails sep-1932-client-dpop-jkt (AS returns 400)
 *  - `exerciseRefresh:true`       → after the token's expires_in, makes more
 *    MCP requests; refreshes (or re-authorizes) first
 *  - `sendRefreshProof:false`     → refresh omits the DPoP proof; fails
 *    sep-1932-client-refresh-proof
 *  - `refreshWithNewKey:true`     → refresh proof uses a different key; fails
 *    sep-1932-client-refresh-proof
 *  - `onExpiry:'reauthorize'`     → runs a new authorization_code flow instead
 *    of refresh; sep-1932-client-refresh-proof is INFO
 */
export interface DpopClientOptions {
  scheme: 'DPoP' | 'Bearer';
  freshProofPerRequest: boolean;
  sendTokenRequestProof: boolean;
  /** Retry the token request with the AS-supplied nonce on a use_dpop_nonce challenge (RFC 9449 §8). */
  handleAsNonce: boolean;
  /** Retry an MCP request with the server-supplied nonce on a use_dpop_nonce challenge (RFC 9449 §9). */
  handleRsNonce: boolean;
  /** Include dpop_jkt on the authorization request (RFC 9449 §10). Default true. */
  sendDpopJkt?: boolean;
  /** Send a dpop_jkt that does not match the token-request proof key. */
  wrongDpopJkt?: boolean;
  /**
   * Keep the session past access-token expiry and recover. Default false, so
   * the nonce-less and nonce postures finish without waiting.
   */
  exerciseRefresh?: boolean;
  /** Include a DPoP proof on the refresh request. Default true. */
  sendRefreshProof?: boolean;
  /** Sign the refresh proof with a new key instead of the bound one. */
  refreshWithNewKey?: boolean;
  /** How to recover once the access token expires. Default `refresh`. */
  onExpiry?: 'refresh' | 'reauthorize';
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

  let accessToken = '';
  let refreshToken: string | undefined;
  let expiresAt = 0;

  const postToken = async (
    body: string,
    proofFor: (nonce?: string) => Promise<string | undefined>
  ): Promise<Response> => {
    const send = async (nonce?: string): Promise<Response> => {
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded'
      };
      const proof = await proofFor(nonce);
      if (proof) headers.dpop = proof;
      return fetch(tokenEndpoint, { method: 'POST', headers, body });
    };
    let response = await send();
    // RFC 9449 §8: retry only on use_dpop_nonce, not on any 400 that happens
    // to carry a DPoP-Nonce header (for example invalid_grant).
    const asNonce = response.headers.get('DPoP-Nonce');
    if (response.status === 400 && asNonce && options.handleAsNonce) {
      const challenge = await response
        .clone()
        .json()
        .catch(() => ({}) as { error?: string });
      if (challenge?.error === 'use_dpop_nonce') {
        response = await send(asNonce);
      }
    }
    return response;
  };

  const rememberTokens = (body: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  }): void => {
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    logger.debug(`Obtained ${body.token_type} access token`);
  };

  // Authorization code + PKCE, then the token request. Callable again so a
  // client can re-authorize instead of refreshing.
  const exchangeAuthorizationCode = async (): Promise<void> => {
    const state = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      state,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    // RFC 9449 §10: bind the authorization code to this DPoP key. Default on so
    // the compliant fixture and the other single-defect variants send a matching
    // dpop_jkt unless they are the dedicated omit/mismatch clients.
    if (options.sendDpopJkt !== false) {
      authorizeParams.set(
        'dpop_jkt',
        options.wrongDpopJkt
          ? (await generateDpopKeyPair()).thumbprint
          : keyPair.thumbprint
      );
    }
    const authorizeUrl = `${authorizationEndpoint}?${authorizeParams.toString()}`;
    const authorizeResponse = await request(authorizeUrl, { method: 'GET' });
    await authorizeResponse.body.text().catch(() => undefined);
    const location = authorizeResponse.headers['location'];
    const locationStr = Array.isArray(location) ? location[0] : location;
    if (!locationStr) {
      throw new Error('Authorization endpoint did not redirect with a code');
    }
    const code = new URL(locationStr).searchParams.get('code');
    if (!code) throw new Error('No authorization code in redirect');

    const tokenResponse = await postToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
        client_id: clientId
      }).toString(),
      async (nonce) => {
        if (!options.sendTokenRequestProof) return undefined;
        return buildDpopProof({
          keyPair,
          htm: 'POST',
          // RFC 9449 §4.2: htu carries no query/fragment (the token endpoint URL
          // may legally have a query, so strip it here).
          htu: stripQuery(tokenEndpoint),
          ...(nonce ? { nonce } : {})
        });
      }
    );
    if (!tokenResponse.ok) {
      throw new Error(`Token request failed: HTTP ${tokenResponse.status}`);
    }
    rememberTokens(await tokenResponse.json());
  };

  const refreshAccessToken = async (): Promise<void> => {
    if (!refreshToken) throw new Error('No refresh token to present');
    const proofKey = options.refreshWithNewKey
      ? await generateDpopKeyPair()
      : keyPair;
    const response = await postToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      }).toString(),
      async (nonce) => {
        if (options.sendRefreshProof === false) return undefined;
        return buildDpopProof({
          keyPair: proofKey,
          htm: 'POST',
          htu: stripQuery(tokenEndpoint),
          ...(nonce ? { nonce } : {})
        });
      }
    );
    if (!response.ok) {
      throw new Error(`Refresh request failed: HTTP ${response.status}`);
    }
    rememberTokens(await response.json());
  };

  const recoverFromExpiry = async (): Promise<void> => {
    if (options.onExpiry === 'reauthorize') {
      await exchangeAuthorizationCode();
      return;
    }
    await refreshAccessToken();
  };

  await exchangeAuthorizationCode();

  // MCP session — present the token to the resource with a per-request proof.
  // On a `use_dpop_nonce` challenge (RFC 9449 §9) a conformant client retries
  // with the server-supplied nonce embedded in the proof. On expiry it
  // refreshes (or re-authorizes) and retries.
  const mcpUrl = `${serverUrl}`;
  let reusableProof: string | undefined;
  let rsNonce: string | undefined;
  const dpopFetch = async (
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (options.exerciseRefresh && expiresAt > 0 && Date.now() >= expiresAt) {
      await recoverFromExpiry();
      reusableProof = undefined;
    }
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
    const wwwAuthenticate = res.headers.get('WWW-Authenticate') ?? '';
    const nonce = res.headers.get('DPoP-Nonce');
    if (
      res.status === 401 &&
      nonce &&
      options.handleRsNonce &&
      wwwAuthenticate.includes('use_dpop_nonce')
    ) {
      rsNonce = nonce;
      reusableProof = undefined; // rebuild the proof carrying the nonce
      res = await attempt();
    } else if (
      res.status === 401 &&
      options.exerciseRefresh &&
      wwwAuthenticate.includes('invalid_token')
    ) {
      await recoverFromExpiry();
      reusableProof = undefined;
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
  if (options.exerciseRefresh) {
    const waitMs = Math.max(0, expiresAt - Date.now()) + 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await client.callTool({ name: 'test-tool', arguments: {} });
    await client.listTools();
  }
  await transport.close();
}

function stripQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}
