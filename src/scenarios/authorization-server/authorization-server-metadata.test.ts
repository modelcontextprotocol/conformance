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

describe('AuthorizationServerOptionsSchema', () => {
  // Dynamic import to avoid circular dependency issues at module level
  async function getSchema() {
    const { AuthorizationServerOptionsSchema } =
      await import('../../schemas.js');
    return AuthorizationServerOptionsSchema;
  }

  it('accepts a valid scenario name', async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      url: 'https://example.com',
      scenario: 'authorization-server-metadata-endpoint'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scenario).toBe(
        'authorization-server-metadata-endpoint'
      );
    }
  });

  it('rejects an unknown scenario name', async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      url: 'https://example.com',
      scenario: 'nonexistent-scenario'
    });
    expect(result.success).toBe(false);
  });

  it('accepts without scenario (optional)', async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      url: 'https://example.com'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scenario).toBeUndefined();
    }
  });
});

describe('printAuthorizationServerResults', () => {
  async function getPrintFn() {
    const { printAuthorizationServerResults } =
      await import('../../runner/authorization-server.js');
    return printAuthorizationServerResults;
  }

  const successCheck = {
    id: 'test-check',
    name: 'TestCheck',
    description: 'A test check',
    status: 'SUCCESS' as const,
    timestamp: new Date().toISOString()
  };

  const failureCheck = {
    id: 'test-check-fail',
    name: 'TestCheckFail',
    description: 'A failing check',
    status: 'FAILURE' as const,
    timestamp: new Date().toISOString(),
    errorMessage: 'Something went wrong'
  };

  it('prints pretty-printed output when verbose is false', async () => {
    const printFn = await getPrintFn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = printFn([successCheck], 'Test scenario description', false);

    expect(result).toEqual({
      passed: 1,
      failed: 0,
      denominator: 1,
      warnings: 0
    });

    // Should print "Checks:" header (pretty format), not raw JSON
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Checks:');
    expect(allOutput).not.toContain('"id"');

    consoleSpy.mockRestore();
  });

  it('prints JSON output when verbose is true', async () => {
    const printFn = await getPrintFn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = printFn([successCheck], 'Test scenario description', true);

    expect(result).toEqual({
      passed: 1,
      failed: 0,
      denominator: 1,
      warnings: 0
    });

    // Should print raw JSON, not "Checks:" header
    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('"id"');
    expect(allOutput).toContain('"test-check"');
    expect(allOutput).not.toMatch(/^Checks:/m);

    consoleSpy.mockRestore();
  });

  it('reports failed checks with error messages', async () => {
    const printFn = await getPrintFn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = printFn(
      [successCheck, failureCheck],
      'Test scenario description',
      false
    );

    expect(result).toEqual({
      passed: 1,
      failed: 1,
      denominator: 2,
      warnings: 0
    });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Failed Checks');
    expect(allOutput).toContain('Something went wrong');

    consoleSpy.mockRestore();
  });
});
