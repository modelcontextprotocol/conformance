import * as jose from 'jose';
import { describe, it, expect } from 'vitest';
import {
  JWT_BEARER_GRANT_TYPE,
  DEFAULT_WORKLOAD_JWT_ALG,
  createWorkloadJwt,
  generateWorkloadKeypair
} from './createWorkloadJwt.js';

describe('constants', () => {
  it('JWT_BEARER_GRANT_TYPE matches the IANA-registered URN format', () => {
    expect(JWT_BEARER_GRANT_TYPE).toMatch(/^urn:ietf:params:oauth:grant-type:/);
    expect(JWT_BEARER_GRANT_TYPE).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    );
  });

  it('DEFAULT_WORKLOAD_JWT_ALG is ES256', () => {
    expect(DEFAULT_WORKLOAD_JWT_ALG).toBe('ES256');
  });
});

describe('generateWorkloadKeypair', () => {
  it('returns an ES256 keypair with PEM and JWK', async () => {
    const kp = await generateWorkloadKeypair();
    expect(kp.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(kp.publicJwk.kty).toBe('EC');
    expect(kp.publicJwk.crv).toBe('P-256');
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();
  });

  it('uses the specified algorithm', async () => {
    const kp = await generateWorkloadKeypair('RS256');
    expect(kp.publicJwk.kty).toBe('RSA');
  });
});

describe('createWorkloadJwt', () => {
  it('produces a verifiable JWT with all standard claims', async () => {
    const kp = await generateWorkloadKeypair();
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'system:serviceaccount:prod:my-app',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey
    });

    const { payload } = await jose.jwtVerify(token, kp.publicKey, {
      issuer: 'https://issuer.example',
      audience: 'https://as.example/token'
    });

    expect(payload.iss).toBe('https://issuer.example');
    expect(payload.sub).toBe('system:serviceaccount:prod:my-app');
    expect(payload.aud).toBe('https://as.example/token');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.jti).toBe('string');
  });

  it('defaults exp to approximately 5 minutes after iat', async () => {
    const kp = await generateWorkloadKeypair();
    const before = Math.floor(Date.now() / 1000);
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey
    });
    const after = Math.floor(Date.now() / 1000);

    const { payload } = await jose.jwtVerify(token, kp.publicKey);
    const lifetime = (payload.exp as number) - (payload.iat as number);
    expect(lifetime).toBeGreaterThanOrEqual(5 * 60 - 2);
    expect(lifetime).toBeLessThanOrEqual(5 * 60 + 2);
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect(payload.iat as number).toBeLessThanOrEqual(after);
  });

  it('accepts a negative duration string as expiresIn for already-expired tokens', async () => {
    const kp = await generateWorkloadKeypair();
    const before = Math.floor(Date.now() / 1000);
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey,
      expiresIn: '-60s'
    });

    const payload = jose.decodeJwt(token);
    expect(payload.exp).toBeLessThan(before);
    await expect(jose.jwtVerify(token, kp.publicKey)).rejects.toThrow();
  });

  it('generates a unique jti on each call with identical inputs', async () => {
    const kp = await generateWorkloadKeypair();
    const opts = {
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey
    };
    const t1 = await createWorkloadJwt(opts);
    const t2 = await createWorkloadJwt(opts);

    const { payload: p1 } = await jose.jwtVerify(t1, kp.publicKey);
    const { payload: p2 } = await jose.jwtVerify(t2, kp.publicKey);
    expect(p1.jti).not.toBe(p2.jti);
  });

  it('preserves an array audience as an array', async () => {
    const kp = await generateWorkloadKeypair();
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: ['https://as.example/token', 'https://other.example'],
      privateKey: kp.privateKey
    });

    const { payload } = await jose.jwtVerify(token, kp.publicKey, {
      audience: 'https://as.example/token'
    });
    expect(Array.isArray(payload.aud)).toBe(true);
    expect(payload.aud).toContain('https://as.example/token');
    expect(payload.aud).toContain('https://other.example');
  });

  it('merges additionalClaims without overriding reserved claims', async () => {
    const kp = await generateWorkloadKeypair();
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey,
      additionalClaims: {
        custom: 'value',
        iss: 'should-be-ignored',
        sub: 'should-be-ignored'
      }
    });

    const { payload } = await jose.jwtVerify(token, kp.publicKey);
    expect(payload.custom).toBe('value');
    expect(payload.iss).toBe('https://issuer.example');
    expect(payload.sub).toBe('workload');
  });

  it('allows caller-supplied jwtId', async () => {
    const kp = await generateWorkloadKeypair();
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey,
      jwtId: 'fixed-jti-for-replay-test'
    });

    const { payload } = await jose.jwtVerify(token, kp.publicKey);
    expect(payload.jti).toBe('fixed-jti-for-replay-test');
  });

  it('sets notBefore when specified', async () => {
    const kp = await generateWorkloadKeypair();
    const nbf = Math.floor(Date.now() / 1000) + 3600;
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey,
      notBefore: nbf
    });

    const payload = jose.decodeJwt(token);
    expect(payload.nbf).toBe(nbf);
  });

  it('uses the specified algorithm when signing', async () => {
    const kp = await generateWorkloadKeypair('RS256');
    const token = await createWorkloadJwt({
      issuer: 'https://issuer.example',
      subject: 'workload',
      audience: 'https://as.example/token',
      privateKey: kp.privateKey,
      algorithm: 'RS256'
    });

    const { payload } = await jose.jwtVerify(token, kp.publicKey, {
      algorithms: ['RS256']
    });
    expect(payload.iss).toBe('https://issuer.example');
  });
});
