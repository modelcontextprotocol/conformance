import { webcrypto } from 'node:crypto';
import * as jose from 'jose';
import type { JWK } from 'jose';
import {
  generateDpopKeyPair,
  buildDpopProof,
  accessTokenHash
} from './dpopProof';
import { generateIssuerKey, mintDpopBoundToken } from './dpopToken';

/** Independent ES256 verification via Node WebCrypto (a different path from jose). */
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

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'https://mcp.example.com/mcp';

describe('DPoP token minter — valid bound token', () => {
  it('mints a token bound to the given thumbprint with correct claims', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      jkt: kp.thumbprint
    });

    const claims = jose.decodeJwt(token);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
    expect(typeof claims.sub).toBe('string');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect((claims.exp as number) > (claims.iat as number)).toBe(true);
    expect((claims.cnf as { jkt: string }).jkt).toBe(kp.thumbprint);

    expect(jose.decodeProtectedHeader(token).typ).toBe('at+jwt');
  });

  it('is signed by the issuer key (independent WebCrypto verification, Layer 2)', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      jkt: kp.thumbprint
    });
    expect(await verifyEs256Independently(token, issuerKey.publicJwk)).toBe(
      true
    );
  });
});

describe('DPoP token minter — proof/token binding agreement (integration)', () => {
  it('proof.ath hashes the minted token and token.cnf.jkt equals the proof key thumbprint', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();

    const token = await mintDpopBoundToken({
      issuerKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      jkt: kp.thumbprint
    });

    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: AUDIENCE,
      accessToken: token
    });

    // The two halves of the sender-constraint must line up:
    const tokenJkt = (jose.decodeJwt(token).cnf as { jkt: string }).jkt;
    const proofJwkThumbprint = kp.thumbprint;
    expect(tokenJkt).toBe(proofJwkThumbprint); // token bound to the proof's key

    const proofAth = jose.decodeJwt(proof).ath;
    expect(proofAth).toBe(accessTokenHash(token)); // proof attests to this token
  });
});

describe('DPoP token minter — invalid variants', () => {
  const base = { issuer: ISSUER, audience: AUDIENCE };

  it('omitCnf produces an unbound token (no cnf)', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      ...base,
      jkt: kp.thumbprint,
      omitCnf: true
    });
    expect(jose.decodeJwt(token).cnf).toBeUndefined();
  });

  it('jktOverride binds to a foreign key (cnf.jkt mismatch case)', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const foreign = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      ...base,
      jkt: kp.thumbprint,
      jktOverride: foreign.thumbprint
    });
    const boundJkt = (jose.decodeJwt(token).cnf as { jkt: string }).jkt;
    expect(boundJkt).toBe(foreign.thumbprint);
    expect(boundJkt).not.toBe(kp.thumbprint);
  });

  it('wrong-audience token still binds correctly (audience-validation case)', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      issuer: ISSUER,
      audience: 'https://other.example.com/mcp',
      jkt: kp.thumbprint
    });
    expect(jose.decodeJwt(token).aud).toBe('https://other.example.com/mcp');
  });

  it('expired produces a token whose exp is in the past', async () => {
    const issuerKey = await generateIssuerKey();
    const kp = await generateDpopKeyPair();
    const token = await mintDpopBoundToken({
      issuerKey,
      ...base,
      jkt: kp.thumbprint,
      expired: true
    });
    const claims = jose.decodeJwt(token);
    expect((claims.exp as number) < (claims.iat as number)).toBe(true);
  });
});
