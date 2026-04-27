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

  it('returns SUCCESS for CIMD check when server metadata includes client_id_metadata_document_supported=true with spec version 2025-11-25', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse({
      ...validMetadata,
      client_id_metadata_document_supported: true
    });

    const checks = await scenario.run(SERVER_URL, '2025-11-25');

    expect(checks).toHaveLength(2);

    const metadataCheck = checks[0];
    expect(metadataCheck.status).toBe('SUCCESS');

    const cimdCheck = checks[1];
    expect(cimdCheck.id).toBe('authorization-server-metadata-cimd');
    expect(cimdCheck.status).toBe('SUCCESS');
    expect(cimdCheck.errorMessage).toBeUndefined();
    expect(cimdCheck.details).toEqual({
      client_id_metadata_document_supported: true
    });
  });

  it('returns FAILURE for CIMD check when server metadata lacks client_id_metadata_document_supported with spec version 2025-11-25', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse(validMetadata);

    const checks = await scenario.run(SERVER_URL, '2025-11-25');

    expect(checks).toHaveLength(2);

    const metadataCheck = checks[0];
    expect(metadataCheck.status).toBe('SUCCESS');

    const cimdCheck = checks[1];
    expect(cimdCheck.id).toBe('authorization-server-metadata-cimd');
    expect(cimdCheck.status).toBe('FAILURE');
    expect(cimdCheck.errorMessage).toContain(
      'client_id_metadata_document_supported'
    );
  });

  it('returns FAILURE for CIMD check when client_id_metadata_document_supported is false with spec version 2025-11-25', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse({
      ...validMetadata,
      client_id_metadata_document_supported: false
    });

    const checks = await scenario.run(SERVER_URL, '2025-11-25');

    expect(checks).toHaveLength(2);

    const metadataCheck = checks[0];
    expect(metadataCheck.status).toBe('SUCCESS');

    const cimdCheck = checks[1];
    expect(cimdCheck.id).toBe('authorization-server-metadata-cimd');
    expect(cimdCheck.status).toBe('FAILURE');
    expect(cimdCheck.errorMessage).toContain(
      'client_id_metadata_document_supported'
    );
    expect(cimdCheck.errorMessage).toContain('false');
  });

  it('does not add CIMD check when spec version is 2025-06-18 even if claim is false', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    mockMetadataResponse({
      ...validMetadata,
      client_id_metadata_document_supported: false
    });

    const checks = await scenario.run(SERVER_URL, '2025-06-18');

    expect(checks).toHaveLength(1);

    const metadataCheck = checks[0];
    expect(metadataCheck.status).toBe('SUCCESS');
  });
});
