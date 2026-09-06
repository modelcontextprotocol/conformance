import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthorizationCodeGrantScenario } from './authorization-code-grant.js';
import { request } from 'undici';
import { startCallbackServer } from '../authorization-server/auth/helpers/createCallbackServer';

vi.mock('undici', () => ({
  request: vi.fn()
}));

vi.mock('../authorization-server/auth/helpers/createCallbackServer', () => ({
  startCallbackServer: vi.fn()
}));

const mockedRequest = vi.mocked(request);
const mockedStartCallbackServer = vi.mocked(startCallbackServer);

const SERVER_URL = 'https://example.com';
const AUTHORIZATION_ENDPOINT = `${SERVER_URL}/auth`;
const TOKEN_ENDPOINT = `${SERVER_URL}/token`;

const OPTIONS = {
  url: SERVER_URL,
  clientId: 'client',
  clientSecret: 'secret',
  port: 3000
};

const METADATA = {
  issuer: SERVER_URL,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  token_endpoint_auth_methods_supported: ['client_secret_post']
};

const METADATA_PRIVATE_KEY_JWT = {
  issuer: SERVER_URL,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  token_endpoint_auth_methods_supported: ['private_key_jwt']
};

const DETAILS = {
  'authorization-server-metadata-endpoint': {
    body: METADATA
  }
};

const DETAILS_PRIVATE_KEY_JWT = {
  'authorization-server-metadata-endpoint': {
    body: METADATA_PRIVATE_KEY_JWT
  }
};

function mockCallbackServer(
  scenario: AuthorizationCodeGrantScenario,
  buildUrl: (state: string) => string
) {
  mockedStartCallbackServer.mockReturnValue({
    waitForCallback: vi.fn().mockImplementation(async () => {
      return buildUrl((scenario as any).state);
    }),
    close: vi.fn()
  } as any);
}

function mockTokenResponse(body: Record<string, unknown>) {
  mockedRequest.mockResolvedValue({
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    },
    body: {
      json: async () => body
    }
  } as any);
}

describe('AuthorizationCodeGrantScenario', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS for valid authorization response and token response', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) =>
        `http://127.0.0.1:3000/callback?code=abc&state=${state}&iss=${SERVER_URL}`
    );

    mockTokenResponse({
      access_token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig0123',
      refresh_token: 'short',
      token_type: 'Bearer'
    });

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();

    expect(check.details).toBeDefined();

    expect((check.details as any).authorizationRequest).toContain(
      AUTHORIZATION_ENDPOINT
    );

    expect((check.details as any).authorizationResponseUrl).toContain(
      'code=abc'
    );

    expect((check.details as any).body.access_token).toBe('eyJh…0123 (len=36)');
    expect((check.details as any).body.refresh_token).toBe('[redacted, len=5]');
    expect((check.details as any).body.token_type).toBe('Bearer');
  });

  it('returns FAILURE when state parameter is invalid and does not request a token', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      () => 'http://127.0.0.1:3000/callback?code=abc&state=invalid'
    );

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Invalid state parameter');
    // CSRF enforcement: the token endpoint must never be called when state
    // doesn't bind to the request we sent.
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('returns FAILURE when the authorization response carries an error parameter', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      () =>
        'http://127.0.0.1:3000/callback?error=access_denied&error_description=nope'
    );

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Authorization error: access_denied');
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('returns FAILURE when code parameter is missing', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?state=${state}`
    );

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Invalid code parameter');
  });

  it('returns FAILURE when iss parameter is invalid', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) =>
        `http://127.0.0.1:3000/callback?code=abc&state=${state}&iss=https://evil.example.com`
    );

    mockTokenResponse({
      access_token: 'access-token',
      token_type: 'Bearer'
    });

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Invalid iss parameter');
  });

  it('returns FAILURE when token response does not include access_token', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?code=abc&state=${state}`
    );

    mockTokenResponse({
      token_type: 'Bearer'
    });

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Missing access_token');
  });

  it('returns FAILURE when token response does not include token_type', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?code=abc&state=${state}`
    );

    mockTokenResponse({
      access_token: 'access-token'
    });

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Missing token_type');
  });

  it('returns FAILURE when token response Content-Type is invalid', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?code=abc&state=${state}`
    );

    mockedRequest.mockResolvedValue({
      statusCode: 200,
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'no-store'
      },
      body: {
        json: async () => ({
          access_token: 'access-token',
          token_type: 'Bearer'
        })
      }
    } as any);

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Invalid Content-Type');
  });

  it('returns FAILURE when token response Cache-Control is invalid', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?code=abc&state=${state}`
    );

    mockedRequest.mockResolvedValue({
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public'
      },
      body: {
        json: async () => ({
          access_token: 'access-token',
          token_type: 'Bearer'
        })
      }
    } as any);

    const checks = await scenario.run(OPTIONS, DETAILS);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Invalid Cache-Control');
  });

  it('returns SKIPPED when client_secret_post and client_secret_basic are missing', async () => {
    const scenario = new AuthorizationCodeGrantScenario();

    mockCallbackServer(
      scenario,
      (state) => `http://127.0.0.1:3000/callback?code=abc&state=${state}`
    );

    const checks = await scenario.run(OPTIONS, DETAILS_PRIVATE_KEY_JWT);

    expect(checks).toHaveLength(1);

    const check = checks[0];

    expect(check.status).toBe('SKIPPED');
  });
});
