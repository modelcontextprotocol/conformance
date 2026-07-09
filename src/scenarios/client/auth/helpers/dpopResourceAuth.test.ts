import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateDpopKeyPair,
  buildDpopProof,
  type DpopKeyPair
} from './dpopProof';
import {
  generateIssuerKey,
  mintDpopBoundToken,
  type TokenIssuerKey
} from './dpopToken';
import { validateResourceProof } from './dpopResourceAuth';

const ISSUER = 'https://auth.example.com';
const RESOURCE = 'https://mcp.example.com/mcp';

// One issuer key for the whole file: the validator verifies presented tokens
// against the issuer key, so minting and validation must share it.
let issuerKey: TokenIssuerKey;
beforeAll(async () => {
  issuerKey = await generateIssuerKey();
});

/** The token-binding argument matching {@link boundToken}'s issuer. */
function binding(boundJkt?: string): {
  issuerKey: TokenIssuerKey;
  issuer: string;
  boundJkt?: string;
} {
  return { issuerKey, issuer: ISSUER, ...(boundJkt ? { boundJkt } : {}) };
}

/** Mint a DPoP-bound token for `kp`'s key, optionally bound to a foreign key. */
async function boundToken(
  kp: DpopKeyPair,
  jktOverride?: string
): Promise<string> {
  return mintDpopBoundToken({
    issuerKey,
    issuer: ISSUER,
    audience: RESOURCE,
    jkt: kp.thumbprint,
    ...(jktOverride ? { jktOverride } : {})
  });
}

describe('validateResourceProof — baseline acceptance and htu normalization', () => {
  it('accepts a valid proof bound to the presented token', async () => {
    const kp = await generateDpopKeyPair();
    const token = await boundToken(kp);
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: RESOURCE,
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding(kp.thumbprint)
    );
    expect(result.ok).toBe(true);
  });

  it('accepts an htu that differs only by RFC 3986 normalization (case, default port)', async () => {
    const kp = await generateDpopKeyPair();
    const token = await boundToken(kp);
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: 'HTTPS://MCP.EXAMPLE.COM:443/mcp',
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an htu with a spurious trailing slash (a distinct URI per RFC 3986)', async () => {
    const kp = await generateDpopKeyPair();
    const token = await boundToken(kp);
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: `${RESOURCE}/`,
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/htu/);
  });
});

describe('validateResourceProof — rejects each single defect', () => {
  async function expectRejected(
    build: Parameters<typeof buildDpopProof>[0],
    method = 'POST',
    tokenJktOverride?: string
  ): Promise<string> {
    const kp = (build.keyPair as DpopKeyPair) ?? (await generateDpopKeyPair());
    const token = await boundToken(kp, tokenJktOverride);
    const proof = await buildDpopProof({ ...build, keyPair: kp });
    const result = await validateResourceProof(
      proof,
      token,
      method,
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.error;
  }

  it('rejects a missing proof', async () => {
    const kp = await generateDpopKeyPair();
    const token = await boundToken(kp);
    const result = await validateResourceProof(
      undefined,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong typ', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: RESOURCE,
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
        htu: RESOURCE,
        symmetric: true
      })
    ).toMatch(/alg/);
  });

  it('rejects a private key embedded in the jwk header', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: RESOURCE,
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
        htu: RESOURCE,
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
        htu: RESOURCE,
        omit: ['jti']
      })
    ).toMatch(/jti/);
  });

  it('rejects an htm that does not match the request method', async () => {
    const kp = await generateDpopKeyPair();
    // proof says GET, request is POST
    expect(
      await expectRejected({ keyPair: kp, htm: 'GET', htu: RESOURCE }, 'POST')
    ).toMatch(/htm/);
  });

  it('rejects an htu that does not match the request URI', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: 'https://elsewhere.example.com/mcp'
      })
    ).toMatch(/htu/);
  });

  it('rejects a stale iat', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: RESOURCE,
        iat: Math.floor(Date.now() / 1000) - 3600
      })
    ).toMatch(/iat/);
  });

  it('rejects a wrong ath', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: RESOURCE,
        athOverride: 'not-the-token-hash'
      })
    ).toMatch(/ath/);
  });

  it('rejects a token bound to a different key (cnf.jkt mismatch)', async () => {
    const kp = await generateDpopKeyPair();
    const foreign = await generateDpopKeyPair();
    const token = await boundToken(kp, foreign.thumbprint);
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: RESOURCE,
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/cnf\.jkt/);
  });

  it('rejects a token signed by a key other than the test AS issuer key', async () => {
    const kp = await generateDpopKeyPair();
    // Self-minted lookalike: correct claims, wrong issuer key.
    const rogueIssuer = await generateIssuerKey();
    const token = await mintDpopBoundToken({
      issuerKey: rogueIssuer,
      issuer: ISSUER,
      audience: RESOURCE,
      jkt: kp.thumbprint
    });
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: RESOURCE,
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/not a valid JWT issued/);
  });

  it('rejects a validly-issued token bound to a different key than the token endpoint bound', async () => {
    // The AS bound the token issued at the token endpoint to `original`; the
    // client presents a different (validly-issued) token bound to `other`.
    const original = await generateDpopKeyPair();
    const other = await generateDpopKeyPair();
    const token = await boundToken(other);
    const proof = await buildDpopProof({
      keyPair: other,
      htm: 'POST',
      htu: RESOURCE,
      accessToken: token
    });
    const result = await validateResourceProof(
      proof,
      token,
      'POST',
      RESOURCE,
      binding(original.thumbprint)
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(
      /not the one issued at the token endpoint/
    );
  });

  it('rejects an htu containing a query string (RFC 9449 §4.2)', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({ keyPair: kp, htm: 'POST', htu: `${RESOURCE}?x=1` })
    ).toMatch(/query or fragment/);
  });

  it('rejects an htu containing a fragment (RFC 9449 §4.2)', async () => {
    const kp = await generateDpopKeyPair();
    expect(
      await expectRejected({
        keyPair: kp,
        htm: 'POST',
        htu: `${RESOURCE}#frag`
      })
    ).toMatch(/query or fragment/);
  });

  it('rejects two comma-joined proofs — multiple DPoP headers (RFC 9449 §4.2)', async () => {
    const kp = await generateDpopKeyPair();
    const token = await boundToken(kp);
    const proof = await buildDpopProof({
      keyPair: kp,
      htm: 'POST',
      htu: RESOURCE,
      accessToken: token
    });
    // Node joins duplicate DPoP headers into one comma-separated value.
    const result = await validateResourceProof(
      `${proof}, ${proof}`,
      token,
      'POST',
      RESOURCE,
      binding()
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(
      /multiple DPoP proof headers/
    );
  });
});
