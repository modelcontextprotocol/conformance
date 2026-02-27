import { describe, it, expect, vi } from 'vitest';
import { AuthorizationServerMetadataEndpointScenario } from './authorization-server-metadata.js';
import { request } from 'undici';

vi.mock('undici', () => ({
  request: vi.fn()
}));

const mockedRequest = vi.mocked(request);

describe('AuthorizationServerMetadataEndpointScenario (SUCCESS only)', () => {
  it('returns SUCCESS for valid authorization server metadata', async () => {
    const scenario = new AuthorizationServerMetadataEndpointScenario();
    const serverUrl =
      'https://example.com/.well-known/oauth-authorization-server';

    mockedRequest.mockResolvedValue({
      statusCode: 200,
      headers: {
        'content-type': 'application/json'
      },
      body: {
        json: async () => ({
          issuer: 'https://example.com',
          authorization_endpoint: 'https://example.com/auth',
          token_endpoint: 'https://example.com/token',
          response_types_supported: ['code']
        })
      }
    } as any);

    const checks = await scenario.run(serverUrl);

    expect(checks).toHaveLength(1);

    const check = checks[0];
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
    expect(check.details).toBeDefined();
    expect(check.details!.contentType).toContain('application/json');
    expect((check.details!.body as any).issuer).toBe('https://example.com');
    expect((check.details!.body as any).authorization_endpoint).toBe(
      'https://example.com/auth'
    );
    expect((check.details!.body as any).token_endpoint).toBe(
      'https://example.com/token'
    );
    expect((check.details!.body as any).response_types_supported).toEqual([
      'code'
    ]);
  });
});
