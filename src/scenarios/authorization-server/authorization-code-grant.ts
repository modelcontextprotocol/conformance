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

const REDIRECT_URI_ORIGIN = 'http://localhost';
const REDIRECT_URI_PATH = '/callback';

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
- The code_challenge parameter MUST NOT be present in the authorization response query parameters
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
      this.state = randomBytes(32).toString('base64url');
      this.codeVerifier = randomBytes(32).toString('base64url');
      this.codeChallenge = createHash('sha256')
        .update(this.codeVerifier)
        .digest('base64url');
      const resultMetadata = details[
        'authorization-server-metadata-endpoint'
      ] as { body?: Record<string, unknown> };
      if (!resultMetadata) {
        throw new Error('Invalid authorization server metadata');
      }
      const body = resultMetadata.body;

      const callback = startCallbackServer(options.port);
      const authorizationRequest = this.buildAuthorizationRequest(body, options);
      console.log(
        'Access the following URL in your browser and complete the authentication process.'
      );
      console.log(authorizationRequest);
      console.log('');

      const authorizationResponseUrl = await callback.waitForCallback(300_000);

      const errors: string[] = [];
      const code = this.validateAuthorizationResponse(
        authorizationResponseUrl,
        body,
        options,
        errors
      );

      const tokenResponse = await this.requestToken(body, options, code);
      if (tokenResponse === null) {
        return [
          this.skippedCheck(
            'Server does not support client_secret_post or client_secret_basic auth methods'
          )
        ];
      }
      this.validateTokenResponse(tokenResponse, errors);

      if (errors.length > 0) {
        return [this.failureCheck(errors.join(', '))];
      }

      return [
        this.successCheck({
          authorizationRequest,
          authorizationResponseUrl,
          body: tokenResponse.body
        })
      ];
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

    const redirectUri = encodeURIComponent(
      `${REDIRECT_URI_ORIGIN}:${options.port}${REDIRECT_URI_PATH}`
    );
    const params =
      `response_type=code&client_id=${options.clientId}&state=${this.state}` +
      `&redirect_uri=${redirectUri}&code_challenge=${this.codeChallenge}` +
      `&code_challenge_method=S256&resource=https%3A%2F%2Fapi.example.com%2Fapp%2F`;

    return `${metadata.authorization_endpoint}?${params}`;
  }

  private validateAuthorizationResponse(
    responseUrl: string,
    metadata: any,
    options: AuthorizationServerOptions,
    errors: string[]
  ): string {
    const url = new URL(responseUrl);

    if (url.origin !== REDIRECT_URI_ORIGIN + ':' + options.port) {
      errors.push(`Invalid origin of redirect URL: ${url.origin}`);
    }
    if (url.pathname !== REDIRECT_URI_PATH) {
      errors.push(`Invalid path of redirect URL: ${url.pathname}`);
    }

    const code = url.searchParams.getAll('code');
    if (code.length !== 1 || code[0] === '') {
      throw new Error(`Invalid code parameter: ${code ?? 'missing'}`);
    }

    const state = url.searchParams.getAll('state');
    if (state.length !== 1 || state[0] !== this.state) {
      errors.push(`Invalid state parameter: ${state ?? 'missing'}`);
    }

    const iss = url.searchParams.getAll('iss');
    if (iss.length > 0) {
      if (iss.length !== 1 || iss[0] !== metadata.issuer) {
        errors.push(`Invalid iss parameter: ${iss}`);
      }
    }

    if (url.searchParams.has('code_challenge')) {
      errors.push('code_challenge must not be present');
    }

    if (url.searchParams.has('error')) {
      errors.push(`Error parameter: ${url.searchParams.get('error')}`);
    }

    return code[0];
  }

  private async requestToken(
    metadata: any,
    options: AuthorizationServerOptions,
    code: string
  ): Promise<{ body: any; headers: any } | null> {
    if (!metadata?.token_endpoint) {
      throw new Error('Unable to obtain token endpoint from metadata');
    }

    const authMethods = metadata.token_endpoint_auth_methods_supported || [];
    let response;
    if (authMethods.includes('client_secret_post')) {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          REDIRECT_URI_ORIGIN + ':' + options.port + REDIRECT_URI_PATH,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: this.codeVerifier
      });

      response = await request(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
    } else if (authMethods.includes('client_secret_basic')) {
      const credentials = Buffer.from(
        `${options.clientId}:${options.clientSecret}`
      ).toString('base64');

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          REDIRECT_URI_ORIGIN + ':' + options.port + REDIRECT_URI_PATH,
        code_verifier: this.codeVerifier
      });

      response = await request(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${credentials}`
        },
        body: params.toString()
      });
    } else {
      // Supporting client authentication methods such as client_secret_jwt, private_key_jwt, and tls_client_auth requires implementing a significant amount of code.
      // Their implementation is marked as TODO and these tests are skipped.
      return null;
    }

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
