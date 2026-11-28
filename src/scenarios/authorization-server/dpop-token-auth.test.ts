import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DPoPAuthorizationServerScenario } from './dpop';
import { request } from 'undici';

vi.mock('undici', () => ({
  request: vi.fn()
}));

vi.mock('./auth/helpers/createCallbackServer', () => ({
  startCallbackServer: vi.fn()
}));

const mockedRequest = vi.mocked(request);

const SERVER_URL = 'https://as.example.com';
const AUTHORIZATION_ENDPOINT = `${SERVER_URL}/authorize`;
const TOKEN_ENDPOINT = `${SERVER_URL}/token`;

// The scenario builds its redirect_uri from a fixed origin + options.port.
const PORT = 3000;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

function metadataWith(authMethods: string[]) {
  return {
    issuer: SERVER_URL,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    dpop_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: authMethods
  };
}

interface CapturedTokenRequest {
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(body: Record<string, unknown>) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  } as any;
}

/**
 * Routes the mocked undici requests the way a compliant auto-approving DPoP AS
 * would: metadata at the well-known URL, a direct 302 to the redirect_uri at
 * the authorization endpoint (the headless path — no callback server needed),
 * and a capture-and-answer token endpoint.
 */
function mockAs(authMethods: string[], captured: CapturedTokenRequest[]) {
  mockedRequest.mockImplementation(async (url: any, opts: any) => {
    const u = url.toString();
    if (u.includes('/.well-known/')) {
      return jsonResponse(metadataWith(authMethods));
    }
    if (u.startsWith(AUTHORIZATION_ENDPOINT)) {
      const state = new URL(u).searchParams.get('state');
      return {
        statusCode: 302,
        headers: {
          location: `${REDIRECT_URI}?code=test-code&state=${state}`
        },
        body: { text: async () => '', json: async () => ({}) }
      } as any;
    }
    if (u.startsWith(TOKEN_ENDPOINT)) {
      captured.push({ headers: opts.headers, body: opts.body.toString() });
      return jsonResponse({
        access_token: 'test-token',
        token_type: 'DPoP',
        expires_in: 3600
      });
    }
    throw new Error(`unexpected request to ${u}`);
  });
}

async function runScenario(authMethods: string[], clientSecret?: string) {
  const captured: CapturedTokenRequest[] = [];
  mockAs(authMethods, captured);
  await new DPoPAuthorizationServerScenario().run(
    {
      url: SERVER_URL,
      port: PORT,
      clientId: 'test-client-id',
      ...(clientSecret && { clientSecret })
    },
    {}
  );
  return captured;
}

describe('DPoPAuthorizationServerScenario — token endpoint auth method selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses client_secret_basic over none when the AS offers both and a secret is configured', async () => {
    const captured = await runScenario(
      ['none', 'client_secret_basic'],
      'test-secret'
    );
    expect(captured.length).toBeGreaterThan(0);
    const expected = Buffer.from('test-client-id:test-secret').toString(
      'base64'
    );
    expect(captured[0].headers.authorization).toBe(`Basic ${expected}`);
  });

  it('uses client_secret_post over none when the AS offers both and a secret is configured', async () => {
    const captured = await runScenario(
      ['none', 'client_secret_post'],
      'test-secret'
    );
    expect(captured.length).toBeGreaterThan(0);
    const params = new URLSearchParams(captured[0].body);
    expect(params.get('client_secret')).toBe('test-secret');
    expect(captured[0].headers.authorization).toBeUndefined();
  });

  it('sends no client credentials when no secret is configured, even if the AS offers secret methods', async () => {
    const captured = await runScenario(['none', 'client_secret_basic']);
    expect(captured.length).toBeGreaterThan(0);
    const params = new URLSearchParams(captured[0].body);
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(params.get('client_secret')).toBeNull();
  });
});
