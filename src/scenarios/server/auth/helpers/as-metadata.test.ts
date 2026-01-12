import { describe, expect, test } from 'vitest';

import { buildAsMetadataDiscoveryAttempts } from './as-metadata';

describe('buildAsMetadataDiscoveryAttempts', () => {
  test('issuer without path components: tries RFC8414 then OIDC at root well-known endpoints', () => {
    const attempts = buildAsMetadataDiscoveryAttempts(
      'https://auth.example.com'
    );

    expect(attempts).toEqual([
      {
        kind: 'RFC8414',
        variant: 'root',
        url: 'https://auth.example.com/.well-known/oauth-authorization-server'
      },
      {
        kind: 'OIDC',
        variant: 'root',
        url: 'https://auth.example.com/.well-known/openid-configuration'
      }
    ]);
  });

  test('issuer with path components: tries RFC8414 path-insert, OIDC path-insert, then OIDC path-append', () => {
    const attempts = buildAsMetadataDiscoveryAttempts(
      'https://auth.example.com/tenant1'
    );

    expect(attempts).toEqual([
      {
        kind: 'RFC8414',
        variant: 'path-insert',
        url: 'https://auth.example.com/.well-known/oauth-authorization-server/tenant1'
      },
      {
        kind: 'OIDC',
        variant: 'path-insert',
        url: 'https://auth.example.com/.well-known/openid-configuration/tenant1'
      },
      {
        kind: 'OIDC',
        variant: 'path-append',
        url: 'https://auth.example.com/tenant1/.well-known/openid-configuration'
      }
    ]);
  });

  test('issuer with trailing slash: path-append normalizes to avoid double slashes', () => {
    const attempts = buildAsMetadataDiscoveryAttempts(
      'https://auth.example.com/tenant1/'
    );

    expect(attempts).toEqual([
      {
        kind: 'RFC8414',
        variant: 'path-insert',
        url: 'https://auth.example.com/.well-known/oauth-authorization-server/tenant1/'
      },
      {
        kind: 'OIDC',
        variant: 'path-insert',
        url: 'https://auth.example.com/.well-known/openid-configuration/tenant1/'
      },
      {
        kind: 'OIDC',
        variant: 'path-append',
        url: 'https://auth.example.com/tenant1/.well-known/openid-configuration'
      }
    ]);
  });
});
