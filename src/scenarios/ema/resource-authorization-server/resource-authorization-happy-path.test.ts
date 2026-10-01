import { describe, it, expect } from 'vitest';
import {
  ResourceServerHappyPathScenario,
  ResourceServerHappyPathWithResourceScenario,
  ResourceServerHappyPathWithScopeScenario
} from './resource-authorization-happy-path';
import {
  createHarness,
  TEST_CLIENT_ID,
  TEST_SCOPE,
  TEST_TRUSTED_MCP_SERVER
} from './test-harness';

const CHECK_IDS = [
  'resource-as-happy-token-response',
  'resource-as-happy-token-cache-control',
  'resource-as-happy-no-refresh-token',
  'resource-as-happy-introspection-active',
  'resource-as-happy-introspection-client-id',
  'resource-as-happy-introspection-sub'
];

const CHECK_IDS_WITH_RESOURCE = [
  'resource-as-happy-with-resource-token-response',
  'resource-as-happy-with-resource-token-cache-control',
  'resource-as-happy-with-resource-no-refresh-token',
  'resource-as-happy-with-resource-introspection-active',
  'resource-as-happy-with-resource-introspection-client-id',
  'resource-as-happy-with-resource-introspection-sub',
  'resource-as-happy-with-resource-introspection-aud-format',
  'resource-as-happy-with-resource-introspection-aud-value'
];

const CHECK_IDS_WITH_SCOPE = [
  'resource-as-happy-with-scope-token-response',
  'resource-as-happy-with-scope-token-cache-control',
  'resource-as-happy-with-scope-no-refresh-token',
  'resource-as-happy-with-scope-introspection-active',
  'resource-as-happy-with-scope-introspection-client-id',
  'resource-as-happy-with-scope-introspection-sub',
  'resource-as-happy-with-scope-introspection-aud-format',
  'resource-as-happy-with-scope-introspection-aud-value',
  'resource-as-happy-with-scope-introspection-scope'
];

describe('ResourceServerHappyPathScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerHappyPathScenario();
    expect(scenario.name).toBe('ema/resource-authorization-server/happy-path');
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({ requireResourceClaim: false });
    try {
      const scenario = new ResourceServerHappyPathScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS);
      for (const check of checks) {
        expect(
          check.status,
          `${check.id} failed: ${check.errorMessage ?? ''}`
        ).toBe('SUCCESS');
      }
    } finally {
      await harness.stop();
    }
  });

  it('introspection reports the configured client_id and sub', async () => {
    const harness = await createHarness({ requireResourceClaim: false });
    try {
      const scenario = new ResourceServerHappyPathScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const clientCheck = checks.find(
        (c) => c.id === 'resource-as-happy-introspection-client-id'
      );
      expect(clientCheck?.details?.client_id).toBe(TEST_CLIENT_ID);

      const subCheck = checks.find(
        (c) => c.id === 'resource-as-happy-introspection-sub'
      );
      expect(subCheck?.status).toBe('SUCCESS');
      expect(subCheck?.details?.sub).toBe(harness.options.sub);
    } finally {
      await harness.stop();
    }
  });

  it('skips when a required setting is missing', async () => {
    const scenario = new ResourceServerHappyPathScenario();
    const checks = await scenario.run(
      { url: 'https://resource-as.example.com' },
      {}
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('SKIPPED');
  });
});

describe('ResourceServerHappyPathWithResourceScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerHappyPathWithResourceScenario();
    expect(scenario.name).toBe(
      'ema/resource-authorization-server/happy-path-with-resource'
    );
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerHappyPathWithResourceScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_WITH_RESOURCE);
      for (const check of checks) {
        expect(
          check.status,
          `${check.id} failed: ${check.errorMessage ?? ''}`
        ).toBe('SUCCESS');
      }
    } finally {
      await harness.stop();
    }
  });

  it('introspection reports a single-valued aud equal to the trusted MCP Server', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerHappyPathWithResourceScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const audValueCheck = checks.find(
        (c) =>
          c.id === 'resource-as-happy-with-resource-introspection-aud-value'
      );
      expect(audValueCheck?.status).toBe('SUCCESS');
      expect(audValueCheck?.details?.aud).toBe(TEST_TRUSTED_MCP_SERVER);
    } finally {
      await harness.stop();
    }
  });
});

describe('ResourceServerHappyPathWithScopeScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerHappyPathWithScopeScenario();
    expect(scenario.name).toBe(
      'ema/resource-authorization-server/happy-path-with-scope'
    );
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      registerScope: true
    });
    try {
      const scenario = new ResourceServerHappyPathWithScopeScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_WITH_SCOPE);
      for (const check of checks) {
        expect(
          check.status,
          `${check.id} failed: ${check.errorMessage ?? ''}`
        ).toBe('SUCCESS');
      }
    } finally {
      await harness.stop();
    }
  });

  it('introspection reports the configured scope', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      registerScope: true
    });
    try {
      const scenario = new ResourceServerHappyPathWithScopeScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const scopeCheck = checks.find(
        (c) => c.id === 'resource-as-happy-with-scope-introspection-scope'
      );
      expect(scopeCheck?.status).toBe('SUCCESS');
      expect(scopeCheck?.details?.scope).toBe(TEST_SCOPE);
    } finally {
      await harness.stop();
    }
  });
});
