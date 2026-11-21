import { describe, it, expect, afterEach } from 'vitest';
import {
  ResourceServerMetadataScenario,
  checkResourceServerMetadata
} from './resource-authorization-metadata';
import {
  MockResourceAuthorizationServer,
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE
} from '../auth/helpers/mockResourceAuthorizationServer';

const CHECK_IDS = [
  'resource-as-metadata-grant-profiles-supported',
  'resource-as-metadata-id-jag-grant-profile',
  'resource-as-metadata-grant-types-supported',
  'resource-as-metadata-jwt-bearer-grant-type'
];

function statusOf(checks: ReturnType<typeof checkResourceServerMetadata>) {
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
}

describe('checkResourceServerMetadata', () => {
  it('passes for well-formed metadata using array claims', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      grant_types_supported: [JWT_BEARER_GRANT_TYPE, 'authorization_code']
    });
    expect(checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(checks.every((c) => c.status === 'SUCCESS')).toBe(true);
  });

  it('accepts a string form of authorization_grant_profiles_supported', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: ID_JAG_GRANT_PROFILE,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE]
    });
    const status = statusOf(checks);
    expect(status['resource-as-metadata-grant-profiles-supported']).toBe(
      'SUCCESS'
    );
    expect(status['resource-as-metadata-id-jag-grant-profile']).toBe('SUCCESS');
  });

  it('fails when authorization_grant_profiles_supported is missing', () => {
    const checks = checkResourceServerMetadata({
      grant_types_supported: [JWT_BEARER_GRANT_TYPE]
    });
    const status = statusOf(checks);
    expect(status['resource-as-metadata-grant-profiles-supported']).toBe(
      'FAILURE'
    );
    expect(status['resource-as-metadata-id-jag-grant-profile']).toBe('FAILURE');
  });

  it('fails when authorization_grant_profiles_supported is not a string/array', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: 42,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE]
    });
    expect(
      statusOf(checks)['resource-as-metadata-grant-profiles-supported']
    ).toBe('FAILURE');
  });

  it('fails when the id-jag profile is not advertised', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: ['urn:example:other-profile'],
      grant_types_supported: [JWT_BEARER_GRANT_TYPE]
    });
    const status = statusOf(checks);
    expect(status['resource-as-metadata-grant-profiles-supported']).toBe(
      'SUCCESS'
    );
    expect(status['resource-as-metadata-id-jag-grant-profile']).toBe('FAILURE');
  });

  it('fails when grant_types_supported is missing', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE]
    });
    const status = statusOf(checks);
    expect(status['resource-as-metadata-grant-types-supported']).toBe(
      'FAILURE'
    );
    expect(status['resource-as-metadata-jwt-bearer-grant-type']).toBe(
      'FAILURE'
    );
  });

  it('fails when grant_types_supported is a string rather than an array', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      grant_types_supported: JWT_BEARER_GRANT_TYPE
    });
    expect(statusOf(checks)['resource-as-metadata-grant-types-supported']).toBe(
      'FAILURE'
    );
  });

  it('fails when the jwt-bearer grant type is not advertised', () => {
    const checks = checkResourceServerMetadata({
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      grant_types_supported: ['authorization_code']
    });
    const status = statusOf(checks);
    expect(status['resource-as-metadata-grant-types-supported']).toBe(
      'SUCCESS'
    );
    expect(status['resource-as-metadata-jwt-bearer-grant-type']).toBe(
      'FAILURE'
    );
  });
});

describe('ResourceServerMetadataScenario', () => {
  it('has a stable name and EMA extension source', () => {
    const scenario = new ResourceServerMetadataScenario();
    expect(scenario.name).toBe('ema/resource-authorization-server/metadata');
    expect(scenario.source).toEqual({
      extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
    });
  });

  it('passes every check against a configured Resource AS', async () => {
    const resourceAs = await MockResourceAuthorizationServer.create();
    await resourceAs.start();
    try {
      const scenario = new ResourceServerMetadataScenario();
      const checks = await scenario.run({ url: resourceAs.issuer }, {});

      expect(checks.map((c) => c.id)).toEqual(CHECK_IDS);
      for (const check of checks) {
        expect(
          check.status,
          `${check.id} failed: ${check.errorMessage ?? ''}`
        ).toBe('SUCCESS');
      }
    } finally {
      await resourceAs.stop();
    }
  });
});

describe('ResourceServerMetadataScenario against a misconfigured Resource AS', () => {
  let resourceAs: MockResourceAuthorizationServer | null = null;

  afterEach(async () => {
    await resourceAs?.stop();
    resourceAs = null;
  });

  it('fails discovery when the Resource AS omits ID-JAG support from its metadata', async () => {
    // Serve metadata that advertises neither the id-jag grant profile nor the
    // jwt-bearer grant type — a Resource AS that does not support the profile.
    resourceAs = await MockResourceAuthorizationServer.create({
      metadataTransform: (defaults) => ({
        issuer: defaults.issuer,
        token_endpoint: defaults.token_endpoint,
        jwks_uri: defaults.jwks_uri,
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported:
          defaults.token_endpoint_auth_methods_supported
      })
    });
    await resourceAs.start();

    const scenario = new ResourceServerMetadataScenario();
    const checks = await scenario.run({ url: resourceAs.issuer }, {});
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));

    // The absent authorization_grant_profiles_supported claim fails both
    // profile checks; the present-but-insufficient grant_types_supported passes
    // the array check but fails the jwt-bearer membership check.
    expect(status['resource-as-metadata-grant-profiles-supported']).toBe(
      'FAILURE'
    );
    expect(status['resource-as-metadata-id-jag-grant-profile']).toBe('FAILURE');
    expect(status['resource-as-metadata-grant-types-supported']).toBe(
      'SUCCESS'
    );
    expect(status['resource-as-metadata-jwt-bearer-grant-type']).toBe(
      'FAILURE'
    );
    expect(checks.some((c) => c.status === 'FAILURE')).toBe(true);
  });

  it('fails every check when the metadata drops both claims entirely', async () => {
    resourceAs = await MockResourceAuthorizationServer.create({
      metadataTransform: (defaults) => ({
        issuer: defaults.issuer,
        token_endpoint: defaults.token_endpoint,
        jwks_uri: defaults.jwks_uri
      })
    });
    await resourceAs.start();

    const scenario = new ResourceServerMetadataScenario();
    const checks = await scenario.run({ url: resourceAs.issuer }, {});

    expect(checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(checks.every((c) => c.status === 'FAILURE')).toBe(true);
  });
});
