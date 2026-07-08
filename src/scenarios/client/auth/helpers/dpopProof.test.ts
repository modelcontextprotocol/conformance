import { webcrypto } from 'node:crypto';
import * as jose from 'jose';
import type { JWK } from 'jose';
import {
  generateDpopKeyPair,
  accessTokenHash,
  jwkThumbprint,
  buildDpopProof
} from './dpopProof';

/**
 * Independent ES256 signature verification using Node's native WebCrypto —
 * a different code path from jose's signer, so a signing bug can't be masked
 * by symmetric use of one library (validation Layer 2).
 */
async function verifyEs256Independently(
  jwt: string,
  publicJwk: JWK
): Promise<boolean> {
  const [h, p, s] = jwt.split('.');
  const key = await webcrypto.subtle.importKey(
    'jwk',
    publicJwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const signature = new Uint8Array(Buffer.from(s, 'base64url'));
  const data = new TextEncoder().encode(`${h}.${p}`);
  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    data
  );
}

describe('DPoP proof helper — RFC 9449 published vectors (Layer 1)', () => {
  // RFC 9449 §4 / §6.1 example: this EC public key's JWK thumbprint is the
  // bound `cnf.jkt` value shown in the spec.
  const RFC9449_EC_JWK: JWK = {
    kty: 'EC',
    x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
    y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
    crv: 'P-256'
  };
  const RFC9449_EXPECTED_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';

  // RFC 9449 §4.1 example: ath = base64url(SHA-256(ASCII access token)).
  const RFC9449_ACCESS_TOKEN = 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU';
  const RFC9449_EXPECTED_ATH = 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo';

  it('reproduces the RFC 9449 JWK thumbprint vector', async () => {
    expect(await jwkThumbprint(RFC9449_EC_JWK)).toBe(RFC9449_EXPECTED_JKT);
  });

  it('reproduces the RFC 9449 access-token-hash (ath) vector', () => {
    expect(accessTokenHash(RFC9449_ACCESS_TOKEN)).toBe(RFC9449_EXPECTED_ATH);
  });
});

describe('DPoP proof helper — key pair', () => {
  it('generates an extractable P-256 public JWK with a consistent thumbprint', async () => {
    const kp = await generateDpopKeyPair();
    expect(kp.publicJwk.kty).toBe('EC');
    expect(kp.publicJwk.crv).toBe('P-256');
    expect(kp.publicJwk.d).toBeUndefined(); // public JWK must not carry the private scalar
    expect(kp.thumbprint).toBe(
      await jose.calculateJwkThumbprint(kp.publicJwk, 'sha256')
    );
  });
});

describe('DPoP proof helper — valid proof', () => {
  it('builds a well-formed dpop+jwt with the required header and claims', async () => {
    const kp = await generateDpopKeyPair();
    const accessToken = 'example-access-token-value';
    const jwt = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: 'https://mcp.example.com/mcp',
      accessToken
    });

    const header = jose.decodeProtectedHeader(jwt);
    expect(header.typ).toBe('dpop+jwt');
    expect(header.alg).toBe('ES256');
    expect((header.jwk as JWK).kty).toBe('EC');
    expect((header.jwk as JWK).d).toBeUndefined();

    const claims = jose.decodeJwt(jwt);
    expect(typeof claims.jti).toBe('string');
    expect(claims.htm).toBe('POST');
    expect(claims.htu).toBe('https://mcp.example.com/mcp');
    expect(typeof claims.iat).toBe('number');
    expect(claims.ath).toBe(accessTokenHash(accessToken));
  });

  it('signature verifies under an independent WebCrypto verifier (Layer 2)', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({
      keyPair: kp,
      htm: 'GET',
      htu: 'https://mcp.example.com/mcp'
    });
    expect(await verifyEs256Independently(jwt, kp.publicJwk)).toBe(true);
  });
});

describe('DPoP proof helper — invalid variants isolate exactly one defect (Layer 3)', () => {
  const base = { htm: 'POST', htu: 'https://mcp.example.com/mcp' };

  it('a tampered signature fails verification while header and claims are unchanged', async () => {
    const kp = await generateDpopKeyPair();
    const good = await buildDpopProof({ keyPair: kp, ...base });
    // Derive the bad proof from the good one so ONLY the signature differs
    // (each build has a fresh jti and ECDSA signatures are randomized, so two
    // independent builds would differ in their claims too).
    const [h, p, s] = good.split('.');
    // Flip the FIRST signature char (fully significant); the last char carries
    // base64url padding bits that can decode identically and stay valid.
    const bad = [h, p, (s[0] === 'A' ? 'B' : 'A') + s.slice(1)].join('.');

    expect(bad.split('.').slice(0, 2)).toEqual([h, p]);
    expect(await verifyEs256Independently(good, kp.publicJwk)).toBe(true);
    expect(await verifyEs256Independently(bad, kp.publicJwk)).toBe(false);
  });

  it('the builder tamperSignature option yields a proof that fails verification', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({
      keyPair: kp,
      ...base,
      tamperSignature: true
    });
    expect(await verifyEs256Independently(jwt, kp.publicJwk)).toBe(false);
  });

  it('omitting jti drops only the jti claim', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({ keyPair: kp, ...base, omit: ['jti'] });
    const claims = jose.decodeJwt(jwt);
    expect(claims.jti).toBeUndefined();
    expect(claims.htm).toBe('POST');
    expect(claims.htu).toBe('https://mcp.example.com/mcp');
    expect(typeof claims.iat).toBe('number');
  });

  it('unsigned variant uses alg=none with an empty signature segment', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({ keyPair: kp, ...base, unsigned: true });
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe('');
    expect(jose.decodeProtectedHeader(jwt).alg).toBe('none');
  });

  it('symmetric variant signs with HS256 (must be rejected by servers)', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({ keyPair: kp, ...base, symmetric: true });
    expect(jose.decodeProtectedHeader(jwt).alg).toBe('HS256');
  });

  it('embedPrivateKey leaks the private scalar into the jwk header', async () => {
    const kp = await generateDpopKeyPair();
    const jwt = await buildDpopProof({
      keyPair: kp,
      ...base,
      embedPrivateKey: true
    });
    expect((jose.decodeProtectedHeader(jwt).jwk as JWK).d).toBeDefined();
  });

  it('iat override produces a stale proof', async () => {
    const kp = await generateDpopKeyPair();
    const staleIat = Math.floor(Date.now() / 1000) - 3600;
    const jwt = await buildDpopProof({ keyPair: kp, ...base, iat: staleIat });
    expect(jose.decodeJwt(jwt).iat).toBe(staleIat);
  });
});
