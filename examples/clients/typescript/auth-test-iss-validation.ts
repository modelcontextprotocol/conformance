#!/usr/bin/env node

/**
 * Well-behaved client that validates the iss parameter in authorization responses.
 *
 * Per RFC 9207:
 * - If the AS advertises authorization_response_iss_parameter_supported: true,
 *   the client MUST require iss in the redirect and MUST validate it against
 *   the AS metadata issuer.
 * - If the AS does NOT advertise support, the client MUST reject any redirect
 *   that unexpectedly contains an iss parameter.
 */

import { createHash, randomBytes } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Middleware } from '@modelcontextprotocol/sdk/client/middleware.js';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function computeS256Challenge(codeVerifier: string): string {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * OAuth flow that correctly validates the iss parameter per RFC 9207.
 */
async function oauthFlowWithIssValidation(
  _serverUrl: string | URL,
  resourceMetadataUrl: string | URL,
  fetchFn: FetchLike
): Promise<OAuthTokens> {
  // 1. Fetch Protected Resource Metadata
  const prmResponse = await fetchFn(resourceMetadataUrl);
  if (!prmResponse.ok) {
    throw new Error(`Failed to fetch PRM: ${prmResponse.status}`);
  }
  const prm = await prmResponse.json();
  const authServerUrl = prm.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error('No authorization server in PRM');
  }

  // 2. Fetch Authorization Server Metadata
  const asMetadataUrl = new URL(
    '/.well-known/oauth-authorization-server',
    authServerUrl
  );
  const asResponse = await fetchFn(asMetadataUrl.toString());
  if (!asResponse.ok) {
    throw new Error(`Failed to fetch AS metadata: ${asResponse.status}`);
  }
  const asMetadata = await asResponse.json();

  const expectedIssuer: string = asMetadata.issuer;
  const issParameterSupported: boolean =
    asMetadata.authorization_response_iss_parameter_supported === true;

  // 3. Register client (DCR)
  const dcrResponse = await fetchFn(asMetadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'test-auth-client-iss-validation',
      redirect_uris: ['http://localhost:3000/callback']
    })
  });
  if (!dcrResponse.ok) {
    throw new Error(`DCR failed: ${dcrResponse.status}`);
  }
  const clientInfo = await dcrResponse.json();

  // 4. Build authorization URL with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);

  const authUrl = new URL(asMetadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientInfo.client_id);
  authUrl.searchParams.set('redirect_uri', 'http://localhost:3000/callback');
  authUrl.searchParams.set('state', 'test-state');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // 5. Fetch authorization endpoint (simulates redirect)
  const authResponse = await fetchFn(authUrl.toString(), {
    redirect: 'manual'
  });
  const location = authResponse.headers.get('location');
  if (!location) {
    throw new Error('No redirect from authorization endpoint');
  }
  const redirectUrl = new URL(location);
  const authCode = redirectUrl.searchParams.get('code');
  if (!authCode) {
    throw new Error('No auth code in redirect');
  }

  // 6. Validate iss parameter per RFC 9207
  const issInRedirect = redirectUrl.searchParams.get('iss');

  if (issParameterSupported) {
    // Server advertised support: iss MUST be present and MUST match metadata issuer
    if (!issInRedirect) {
      throw new Error(
        'Server advertised authorization_response_iss_parameter_supported but iss is absent from redirect'
      );
    }
    if (issInRedirect !== expectedIssuer) {
      throw new Error(
        `iss mismatch: expected '${expectedIssuer}', got '${issInRedirect}'`
      );
    }
  } else {
    // Server did NOT advertise support: iss MUST NOT be present
    if (issInRedirect) {
      throw new Error(
        `Unexpected iss parameter in redirect: server did not advertise authorization_response_iss_parameter_supported`
      );
    }
  }

  // 7. Exchange code for token with PKCE code_verifier
  const tokenResponse = await fetchFn(asMetadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: 'http://localhost:3000/callback',
      client_id: clientInfo.client_id,
      code_verifier: codeVerifier
    }).toString()
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token request failed: ${tokenResponse.status} - ${error}`);
  }

  return tokenResponse.json();
}

/**
 * Creates a fetch wrapper that uses OAuth with iss parameter validation.
 */
function withOAuthIssValidation(baseUrl: string | URL): Middleware {
  let tokens: OAuthTokens | undefined;

  return (next: FetchLike) => {
    return async (
      input: string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const makeRequest = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);
        if (tokens) {
          headers.set('Authorization', `Bearer ${tokens.access_token}`);
        }
        return next(input, { ...init, headers });
      };

      let response = await makeRequest();

      if (response.status === 401) {
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
        if (!resourceMetadataUrl) {
          throw new Error('No resource_metadata in WWW-Authenticate');
        }
        tokens = await oauthFlowWithIssValidation(
          baseUrl,
          resourceMetadataUrl,
          next
        );
        response = await makeRequest();
      }

      return response;
    };
  };
}

export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client-iss-validation', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthIssValidation(new URL(serverUrl))(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('Successfully connected to MCP server');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await transport.close();
  logger.debug('Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test-iss-validation <server-url>');
