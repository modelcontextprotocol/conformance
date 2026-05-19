import { describe, it, expect, vi } from 'vitest';
import { AuthorizationServerMetadataEndpointScenario } from './authorization-server-metadata.js';
import { request } from 'undici';

vi.mock('undici', () => ({
  request: vi.fn()
}));

const mockedRequest = vi.mocked(request);

const SERVER_URL = 'https://example.com';
const AUTHORIZATION_ENDPOINT = `${SERVER_URL}/auth`;
const TOKEN_ENDPOINT = `${SERVER_URL}/token`;

const validMetadata = {
  issuer: SERVER_URL,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['plain', 'S256']
};

function mockMetadataResponse(body: Record<string, unknown>) {
  mockedRequest.mockResolvedValue({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { json: async () => body }
  } as any);
}

describe('AuthorizationServerMetadataEndpointScenario', () => {
  it('returns SUCCESS for valid authorization server metadata', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse(validMetadata);

    const checks = await scenario.run(SERVER_URL);

    expect(checks).toHaveLength(1);

    const check = checks[0];
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
    expect(check.details).toBeDefined();
    expect(check.details!.contentType).toContain('application/json');
    expect((check.details!.body as any).issuer).toBe(SERVER_URL);
    expect((check.details!.body as any).authorization_endpoint).toBe(
      AUTHORIZATION_ENDPOINT
    );
    expect((check.details!.body as any).token_endpoint).toBe(TOKEN_ENDPOINT);
    expect((check.details!.body as any).response_types_supported).toEqual([
      'code'
    ]);
    expect(
      (check.details!.body as any).code_challenge_methods_supported
    ).toEqual(['plain', 'S256']);
  });

  it('returns FAILURE when code_challenge_methods_supported is missing', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse({
      issuer: validMetadata.issuer,
      authorization_endpoint: validMetadata.authorization_endpoint,
      token_endpoint: validMetadata.token_endpoint,
      response_types_supported: validMetadata.response_types_supported
    });

    const checks = await scenario.run(SERVER_URL);

    expect(checks).toHaveLength(1);

    const check = checks[0];
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('code_challenge_methods_supported');
  });

  it('returns FAILURE when code_challenge_methods_supported does not include S256', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse({
      ...validMetadata,
      code_challenge_methods_supported: ['plain']
    });

    const checks = await scenario.run(SERVER_URL);

    expect(checks).toHaveLength(1);

    const check = checks[0];
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('code_challenge_methods_supported');
  });
});
