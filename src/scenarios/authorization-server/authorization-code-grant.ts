/**
 * Authorization code grant test scenarios for MCP authorization servers
 */
import {
  ClientScenarioForAuthorizationServer,
  ConformanceCheck
} from '../../types';
import { startCallbackServer } from '../authorization-server/auth/helpers/createCallbackServer';
import { request } from 'undici';
import { createHash, randomBytes } from 'crypto';
import { AuthorizationServerOptions } from '../../schemas';
import { SpecReferences } from '../authorization-server/auth/spec-references';

const REDIRECT_URI_ORIGIN = 'http://127.0.0.1';
const REDIRECT_URI_PATH = '/callback';

const REDACTED_KEYS = ['access_token', 'refresh_token', 'id_token'] as const;

/**
 * Mask live token material so it never lands in checks.json. Keep a short
 * prefix/suffix so the value can still be correlated against AS logs.
 * Tokens shorter than 16 chars are fully redacted.
 */
function redactTokens(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of REDACTED_KEYS) {
    const value = out[key];
    if (typeof value === 'string') {
      out[key] =
        value.length < 16
          ? `[redacted, len=${value.length}]`
          : `${value.slice(0, 4)}…${value.slice(-4)} (len=${value.length})`;
    }
  }
  return out;
}

export class AuthorizationCodeGrantScenario implements ClientScenarioForAuthorizationServer {
  private state = randomBytes(32).toString('base64url');
  private codeVerifier = '';
  private codeChallenge = '';
  name = 'authorization-code-grant';
  readonly source = { introducedIn: '2025-03-26' } as const;
  description = `Test authorization code grant.

**Authorization Server Implementation Requirements:**

**Endpoint**: \`authorization endpoint\`, \`token endpoint\`

**Requirements**:
- The URI in the authorization response MUST match the redirect_uri parameter in the authorization request
- The code parameter MUST be present in the authorization response query parameters
- The code parameter MUST have a value
- The state parameter in the authorization response MUST match the state parameter in the authorization request query parameters if the state parameter is present in the authorization request query parameters
- The iss parameter in the authorization response MUST match the issuer claim of authorization server metadata if the iss parameter is present in the authorization response query parameters
- The code, state and iss parameters MUST NOT appear more than once
- The error parameter MUST NOT be present in the authorization response query parameters
- HTTP response status code of token response MUST be 200 OK
- Content-Type header of token response MUST be application/json
- Cache-Control header of token response MUST be no-store
- Token response MUST return a JSON response including access_token and token_type`;

  async run(
    options: AuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      if (!options.clientId) {
        return [
          this.skippedCheck('authorization-code-grant requires --client-id')
        ];
      }

      this.state = randomBytes(32).toString('base64url');
      this.codeVerifier = randomBytes(32).toString('base64url');
      this.codeChallenge = createHash('sha256')
        .update(this.codeVerifier)
        .digest('base64url');

      const resultMetadata = details[
        'authorization-server-metadata-endpoint'
      ] as { body?: Record<string, unknown> };
      if (!resultMetadata?.body) {
        throw new Error('Invalid authorization server metadata');
      }
      const metadata = resultMetadata.body;

      // Decide how we'll authenticate to the token endpoint *before*
      // binding a port and asking the user to open a browser.
      const authMethod = this.selectTokenAuthMethod(metadata, options);
      if (authMethod === null) {
        return [
          this.skippedCheck(
            'Server does not support client_secret_post, client_secret_basic, or none auth methods'
          )
        ];
      }

      const callback = startCallbackServer(options.port);
      try {
        const authorizationRequest = this.buildAuthorizationRequest(
          metadata,
          options
        );
        console.log(
          `Ensure ${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH} is registered as a redirect URI for client '${options.clientId}'.`
        );
        console.log(
          'Access the following URL in your browser and complete the authentication process.'
        );
        console.log(authorizationRequest);
        console.log('');
        console.log(
          'Waiting up to 5 minutes for the authorization callback...'
        );

        const authorizationResponseUrl =
          await callback.waitForCallback(300_000);

        const errors: string[] = [];
        const code = this.validateAuthorizationResponse(
          authorizationResponseUrl,
          metadata,
          options,
          errors
        );

        const tokenResponse = await this.requestToken(
          metadata,
          options,
          code,
          authMethod
        );
        this.validateTokenResponse(tokenResponse, errors);

        if (errors.length > 0) {
          return [this.failureCheck(errors.join(', '))];
        }

        return [
          this.successCheck({
            authorizationRequest,
            authorizationResponseUrl,
            body: redactTokens(tokenResponse.body)
          })
        ];
      } finally {
        callback.close();
      }
    } catch (error) {
      return [this.failureCheck(error)];
    }
  }

  private buildAuthorizationRequest(
    metadata: any,
    options: AuthorizationServerOptions
  ): string {
    if (!metadata?.authorization_endpoint) {
      throw new Error('Unable to obtain authorization endpoint from metadata');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: options.clientId ?? '',
      state: this.state,
      redirect_uri: `${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH}`,
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256'
    });

    return `${metadata.authorization_endpoint}?${params.toString()}`;
  }

  private validateAuthorizationResponse(
    responseUrl: string,
    metadata: any,
    options: AuthorizationServerOptions,
    errors: string[]
  ): string {
    const url = new URL(responseUrl);

    // RFC 6749 §4.1.2.1: an error response and a code response are mutually
    // exclusive. Surface the AS-reported error before any other validation.
    if (url.searchParams.has('error')) {
      const error = url.searchParams.get('error');
      const desc = url.searchParams.get('error_description');
      throw new Error(`Authorization error: ${error} ${desc ?? ''}`.trim());
    }

    if (url.origin !== REDIRECT_URI_ORIGIN + ':' + options.port) {
      errors.push(`Invalid origin of redirect URL: ${url.origin}`);
    }
    if (url.pathname !== REDIRECT_URI_PATH) {
      errors.push(`Invalid path of redirect URL: ${url.pathname}`);
    }

    // CSRF binding: state mismatch is fatal — never proceed to token
    // exchange with an unbound authorization response.
    const state = url.searchParams.getAll('state');
    if (state.length !== 1 || state[0] !== this.state) {
      throw new Error(
        `Invalid state parameter: ${state.join(',') || 'missing'}`
      );
    }

    const code = url.searchParams.getAll('code');
    if (code.length !== 1 || code[0] === '') {
      throw new Error(`Invalid code parameter: ${code.join(',') || 'missing'}`);
    }

    const iss = url.searchParams.getAll('iss');
    if (iss.length > 0) {
      if (iss.length !== 1 || iss[0] !== metadata.issuer) {
        errors.push(`Invalid iss parameter: ${iss}`);
      }
    }

    return code[0];
  }

  private selectTokenAuthMethod(
    metadata: any,
    options: AuthorizationServerOptions
  ): 'none' | 'client_secret_post' | 'client_secret_basic' | null {
    // RFC 8414 §2: omitted token_endpoint_auth_methods_supported means
    // the default is "client_secret_basic".
    const authMethods: string[] =
      metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];

    if (!options.clientSecret || authMethods.includes('none')) {
      return 'none';
    }
    if (authMethods.includes('client_secret_post')) {
      return 'client_secret_post';
    }
    if (authMethods.includes('client_secret_basic')) {
      return 'client_secret_basic';
    }
    // client_secret_jwt / private_key_jwt / tls_client_auth are not yet
    // implemented; skip rather than fail.
    return null;
  }

  private async requestToken(
    metadata: any,
    options: AuthorizationServerOptions,
    code: string,
    authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  ): Promise<{ body: any; headers: any }> {
    if (!metadata?.token_endpoint) {
      throw new Error('Unable to obtain token endpoint from metadata');
    }

    const redirectUri = `${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: this.codeVerifier
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded'
    };

    if (authMethod === 'none') {
      // Public client (PKCE-only). RFC 6749 §3.2.1: client_id in the body.
      params.set('client_id', options.clientId!);
    } else if (authMethod === 'client_secret_post') {
      params.set('client_id', options.clientId!);
      params.set('client_secret', options.clientSecret!);
    } else {
      // RFC 6749 §2.3.1: form-urlencode each component before base64.
      const credentials = Buffer.from(
        `${encodeURIComponent(options.clientId!)}:${encodeURIComponent(options.clientSecret!)}`
      ).toString('base64');
      headers.authorization = `Basic ${credentials}`;
    }

    const response = await request(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body: params.toString()
    });

    if (response.statusCode !== 200) {
      throw new Error(`Invalid status code: ${response.statusCode}`);
    }

    const body = await response.body.json();
    return { body, headers: response.headers };
  }

  private validateTokenResponse(
    response: {
      body: any;
      headers: any;
    },
    errors: string[]
  ): void {
    const { body, headers } = response;

    this.assertHeader(
      headers['content-type'],
      'application/json',
      'Content-Type',
      errors
    );
    this.assertHeader(
      headers['cache-control'],
      'no-store',
      'Cache-Control',
      errors
    );

    if (typeof body !== 'object' || body === null) {
      throw new Error('Token response body is not an object');
    }

    if (typeof body.access_token !== 'string') {
      errors.push('Missing access_token');
    }

    if (typeof body.token_type !== 'string') {
      errors.push('Missing token_type');
    }
  }

  private assertHeader(
    value: unknown,
    expected: string,
    name: string,
    errors: string[]
  ): void {
    if (typeof value !== 'string' || !value.toLowerCase().includes(expected)) {
      errors.push(`Invalid ${name}: ${value ?? '(missing)'}`);
    }
  }

  private successCheck(details: any): ConformanceCheck {
    return {
      id: 'authorization-code-grant',
      name: 'AuthorizationCodeGrant',
      description: 'Valid authorization code grant',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_CODE_GRANT],
      details
    };
  }

  private failureCheck(error: unknown): ConformanceCheck {
    return {
      id: 'authorization-code-grant',
      name: 'AuthorizationCodeGrant',
      description: 'Valid authorization code grant',
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_CODE_GRANT]
    };
  }

  private skippedCheck(reason: string): ConformanceCheck {
    return {
      id: 'authorization-code-grant',
      name: 'AuthorizationCodeGrant',
      description: 'Valid authorization code grant',
      status: 'SKIPPED',
      timestamp: new Date().toISOString(),
      errorMessage: reason,
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_CODE_GRANT]
    };
  }
}
