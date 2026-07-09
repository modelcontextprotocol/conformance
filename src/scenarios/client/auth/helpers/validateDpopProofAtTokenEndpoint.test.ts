import { describe, it, expect } from 'vitest';
import {
  generateDpopKeyPair,
  buildDpopProof,
  type DpopKeyPair
} from './dpopProof';
import { validateDpopProofAtTokenEndpoint } from './createAuthServer';

const TOKEN_ENDPOINT = 'https://auth.example.com/token';

/**
 * The token-endpoint validator is an INDEPENDENT copy of the resource-side
 * validator (dpopResourceAuth). These tests keep the two from drifting: they
 * cover the token-request subset of RFC 9449 §4.3 (no `ath`/`cnf` — there is no
 * access token yet at the token request).
 */
describe('validateDpopProofAtTokenEndpoint — baseline acceptance, htu normalization, alg negotiation', () => {
  it('accepts a well-formed proof and returns the JWK thumbprint', async () => {
    const kp = await generateDpopKeyPair();
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: TOKEN_ENDPOINT
    });
    const result = await validateDpopProofAtTokenEndpoint(
      proof,
      TOKEN_ENDPOINT
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.jkt : '').toBe(kp.thumbprint);
  });

  it('accepts an htu differing only by RFC 3986 normalization (case, default port)', async () => {
    const kp = await generateDpopKeyPair();
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: 'HTTPS://AUTH.EXAMPLE.COM:443/token'
    });
    const result = await validateDpopProofAtTokenEndpoint(
      proof,
      TOKEN_ENDPOINT
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a proof signed with an alg outside the advertised list (RFC 9449 §5.1)', async () => {
    const kp = await generateDpopKeyPair();
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: TOKEN_ENDPOINT
    });
    // Proof is ES256; the AS advertises RS256 only.
    const result = await validateDpopProofAtTokenEndpoint(
      proof,
      TOKEN_ENDPOINT,
      ['RS256']
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(
      /dpop_signing_alg_values_supported/
    );
  });

  it('rejects an htu with a spurious trailing slash (a distinct URI per RFC 3986)', async () => {
    const kp = await generateDpopKeyPair();
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: `${TOKEN_ENDPOINT}/`
    });
    const result = await validateDpopProofAtTokenEndpoint(
      proof,
      TOKEN_ENDPOINT
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/htu/);
  });
});

describe('validateDpopProofAtTokenEndpoint — rejects each single defect', () => {
  async function expectRejected(
    build: Parameters<typeof buildDpopProof>[0]
  ): Promise<string> {
    const kp = (build.keyPair as DpopKeyPair) ?? (await generateDpopKeyPair());
    const proof = await buildDpopProof({ ...build, keyPair: kp });
    const result = await validateDpopProofAtTokenEndpoint(
      proof,
      TOKEN_ENDPOINT
    );
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.error;
  }

  it('rejects a non-JWT', async () => {
    const result = await validateDpopProofAtTokenEndpoint(
      'this-is-not-a-jwt',
      TOKEN_ENDPOINT
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong typ', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        typ: 'jwt'
      })
    ).toMatch(/typ/);
  });

  it('rejects a symmetric algorithm', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        symmetric: true
      })
    ).toMatch(/alg/);
  });

  it('rejects an unsigned (alg=none) proof', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        unsigned: true
      })
    ).toMatch(/alg/);
  });

  it('rejects a private key embedded in the jwk header', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        embedPrivateKey: true
      })
    ).toMatch(/private key/);
  });

  it('rejects a tampered signature', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        tamperSignature: true
      })
    ).toMatch(/signature/);
  });

  it('rejects a missing jti', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        omit: ['jti']
      })
    ).toMatch(/jti/);
  });

  it('rejects an htm that is not POST', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({ keyPair: kp, htm: 'GET', htu: TOKEN_ENDPOINT })
    ).toMatch(/htm/);
  });

  it('rejects an htu that does not match the token endpoint', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: 'https://wrong.example.com/token'
      })
    ).toMatch(/htu/);
  });

  it('rejects an htu containing a query string (RFC 9449 §4.2)', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: `${TOKEN_ENDPOINT}?tenant=x`
      })
    ).toMatch(/query or fragment/);
  });

  it('rejects an htu containing a fragment (RFC 9449 §4.2)', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: `${TOKEN_ENDPOINT}#frag`
      })
    ).toMatch(/query or fragment/);
  });

  it('rejects a stale iat', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: TOKEN_ENDPOINT,
        iat: Math.floor(Date.now() / 1000) - 3600
      })
    ).toMatch(/iat/);
  });
});
