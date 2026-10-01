import { describe, it, expect } from 'vitest';
import {
  ResourceServerErrorPathScenario,
  ResourceServerInvalidScopeScenario,
  ResourceServerInvalidSignatureScenario,
  ResourceServerUntrustedIdpScenario
} from './resource-authorization-error-path';
import { createHarness } from './test-harness';

const CHECK_IDS = [
  'resource-as-error-invalid-target-status',
  'resource-as-error-invalid-target-code'
];

const CHECK_IDS_INVALID_SCOPE = [
  'resource-as-error-invalid-scope-status',
  'resource-as-error-invalid-scope-code'
];

const CHECK_IDS_INVALID_SIGNATURE = [
  'resource-as-error-invalid-signature-status',
  'resource-as-error-invalid-signature-code'
];

const CHECK_IDS_UNTRUSTED_IDP = [
  'resource-as-error-untrusted-idp-status',
  'resource-as-error-untrusted-idp-code'
];

describe('ResourceServerErrorPathScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerErrorPathScenario();
    expect(scenario.name).toBe('ema/resource-authorization-server/error-path');
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerErrorPathScenario();
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

  it('rejects the untrusted resource with 400 invalid_target', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerErrorPathScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const statusCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-target-status'
      );
      expect(statusCheck?.details?.statusCode).toBe(400);

      const errorCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-target-code'
      );
      expect(errorCheck?.details?.error).toBe('invalid_target');
    } finally {
      await harness.stop();
    }
  });

  it('skips when the untrustedMcpServer setting is missing', async () => {
    const scenario = new ResourceServerErrorPathScenario();
    const checks = await scenario.run(
      {
        url: 'https://resource-as.example.com',
        clientId: 'mcp-client',
        clientSecret: 'secret',
        idpSub: 'idp-user-123'
      },
      {}
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('SKIPPED');
  });
});

describe('ResourceServerInvalidScopeScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerInvalidScopeScenario();
    expect(scenario.name).toBe(
      'ema/resource-authorization-server/error-path-invalid-scope'
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
      const scenario = new ResourceServerInvalidScopeScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_INVALID_SCOPE);
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

  it('rejects the unregistered scope with 400 invalid_scope', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      registerScope: true
    });
    try {
      const scenario = new ResourceServerInvalidScopeScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const statusCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-scope-status'
      );
      expect(statusCheck?.details?.statusCode).toBe(400);

      const errorCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-scope-code'
      );
      expect(errorCheck?.details?.error).toBe('invalid_scope');
    } finally {
      await harness.stop();
    }
  });
});

describe('ResourceServerInvalidSignatureScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerInvalidSignatureScenario();
    expect(scenario.name).toBe(
      'ema/resource-authorization-server/error-path-invalid-signature'
    );
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerInvalidSignatureScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_INVALID_SIGNATURE);
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

  it('rejects the unverifiable signature with 400 invalid_grant', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerInvalidSignatureScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const statusCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-signature-status'
      );
      expect(statusCheck?.details?.statusCode).toBe(400);

      const errorCheck = checks.find(
        (c) => c.id === 'resource-as-error-invalid-signature-code'
      );
      expect(errorCheck?.details?.error).toBe('invalid_grant');
    } finally {
      await harness.stop();
    }
  });

  it('skips when a required setting is missing', async () => {
    const scenario = new ResourceServerInvalidSignatureScenario();
    const checks = await scenario.run(
      { url: 'https://resource-as.example.com' },
      {}
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('SKIPPED');
  });

  it('does not require a registered user (idpSub)', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const optionsWithoutSub = { ...harness.options };
      delete optionsWithoutSub.idpSub;
      const scenario = new ResourceServerInvalidSignatureScenario();
      const checks = await scenario.run(optionsWithoutSub, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_INVALID_SIGNATURE);
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
});

describe('ResourceServerUntrustedIdpScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerUntrustedIdpScenario();
    expect(scenario.name).toBe(
      'ema/resource-authorization-server/error-path-untrusted-idp'
    );
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      provisionUntrustedIdp: true
    });
    try {
      const scenario = new ResourceServerUntrustedIdpScenario();
      const checks = await scenario.run(harness.options, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_UNTRUSTED_IDP);
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

  it('rejects the untrusted issuer with 400 invalid_grant', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      provisionUntrustedIdp: true
    });
    try {
      const scenario = new ResourceServerUntrustedIdpScenario();
      const checks = await scenario.run(harness.options, harness.details);

      const statusCheck = checks.find(
        (c) => c.id === 'resource-as-error-untrusted-idp-status'
      );
      expect(statusCheck?.details?.statusCode).toBe(400);

      const errorCheck = checks.find(
        (c) => c.id === 'resource-as-error-untrusted-idp-code'
      );
      expect(errorCheck?.details?.error).toBe('invalid_grant');
    } finally {
      await harness.stop();
    }
  });

  it('skips when a required setting is missing', async () => {
    const scenario = new ResourceServerUntrustedIdpScenario();
    const checks = await scenario.run(
      { url: 'https://resource-as.example.com' },
      {}
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('SKIPPED');
  });

  it('skips when no untrusted IdP AS is supplied via details', async () => {
    const harness = await createHarness({ registerTrustedMcpServer: true });
    try {
      const scenario = new ResourceServerUntrustedIdpScenario();
      const checks = await scenario.run(harness.options, harness.details);
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe('SKIPPED');
    } finally {
      await harness.stop();
    }
  });

  it('does not require a registered user (idpSub)', async () => {
    const harness = await createHarness({
      registerTrustedMcpServer: true,
      provisionUntrustedIdp: true
    });
    try {
      const optionsWithoutSub = { ...harness.options };
      delete optionsWithoutSub.idpSub;
      const scenario = new ResourceServerUntrustedIdpScenario();
      const checks = await scenario.run(optionsWithoutSub, harness.details);

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS_UNTRUSTED_IDP);
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
});
