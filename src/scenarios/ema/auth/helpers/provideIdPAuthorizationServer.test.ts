import { describe, it, expect, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as jose from 'jose';
import type { JWK } from 'jose';
import {
  ID_JAG_ALG,
  ID_JAG_TYP,
  OAUTH_AS_WELL_KNOWN,
  TOKEN_EXCHANGE_GRANT_TYPE,
  createIdPKeyPair,
  verifyIdPKeyPair,
  createIdJag,
  verifyIdJag,
  fetchIdPServerMetadata,
  fetchJwks,
  IdPAuthorizationServer
} from './provideIdPAuthorizationServer';

/**
 * Independent ES256 verification via Node's native WebCrypto — a different code
 * path from jose's verifier, so a signing bug can't be masked by symmetric use
 * of a single library.
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

describe('createIdPKeyPair / verifyIdPKeyPair', () => {
  it('creates an ES256 (EC P-256) key pair annotated for a JWK Set', async () => {
    const kp = await createIdPKeyPair();
    expect(kp.publicJwk.kty).toBe('EC');
    expect(kp.publicJwk.crv).toBe('P-256');
    expect(kp.publicJwk.alg).toBe(ID_JAG_ALG);
    expect(kp.publicJwk.use).toBe('sig');
    expect(kp.publicJwk.kid).toBe(kp.kid);
    // Public JWK must not carry the private component.
    expect((kp.publicJwk as Record<string, unknown>).d).toBeUndefined();
  });

  it('honours a custom kid', async () => {
    const kp = await createIdPKeyPair('trusted-idp-key');
    expect(kp.kid).toBe('trusted-idp-key');
    expect(kp.publicJwk.kid).toBe('trusted-idp-key');
  });

  it('verifies a freshly generated key pair round-trips', async () => {
    const kp = await createIdPKeyPair();
    expect(await verifyIdPKeyPair(kp)).toBe(true);
  });

  it('rejects a key pair whose public JWK does not match the private key', async () => {
    const a = await createIdPKeyPair();
    const b = await createIdPKeyPair();
    const mismatched = { ...a, publicJwk: b.publicJwk };
    expect(await verifyIdPKeyPair(mismatched)).toBe(false);
  });
});

describe('createIdJag / verifyIdJag', () => {
  it('signs an ID-JAG with the id-jag type header and required claims', async () => {
    const kp = await createIdPKeyPair();
    const idJag = await createIdJag(kp.privateKey, kp.kid, {
      issuer: 'https://idp.example',
      subject: 'U123',
      audience: 'https://resource-as.example/',
      resource: 'https://mcp.example/',
      clientId: 'client-abc',
      scope: 'mcp.read mcp.write',
      email: 'user@example.com'
    });

    const header = jose.decodeProtectedHeader(idJag);
    expect(header.typ).toBe(ID_JAG_TYP);
    expect(header.alg).toBe(ID_JAG_ALG);
    expect(header.kid).toBe(kp.kid);

    const payload = jose.decodeJwt(idJag);
    expect(payload.iss).toBe('https://idp.example');
    expect(payload.sub).toBe('U123');
    expect(payload.aud).toBe('https://resource-as.example/');
    expect(payload.resource).toBe('https://mcp.example/');
    expect(payload.client_id).toBe('client-abc');
    expect(payload.scope).toBe('mcp.read mcp.write');
    expect(payload.email).toBe('user@example.com');
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('produces a signature verifiable by an independent ES256 verifier', async () => {
    const kp = await createIdPKeyPair();
    const idJag = await createIdJag(kp.privateKey, kp.kid, {
      issuer: 'https://idp.example',
      subject: 'U123',
      audience: 'https://resource-as.example/'
    });
    expect(await verifyEs256Independently(idJag, kp.publicJwk)).toBe(true);
  });

  it('verifyIdJag accepts a valid grant and returns its claims', async () => {
    const kp = await createIdPKeyPair();
    const idJag = await createIdJag(kp.privateKey, kp.kid, {
      issuer: 'https://idp.example',
      subject: 'U123',
      audience: 'https://resource-as.example/'
    });
    const { header, payload } = await verifyIdJag(idJag, kp.publicJwk, {
      issuer: 'https://idp.example',
      audience: 'https://resource-as.example/'
    });
    expect(header.typ).toBe(ID_JAG_TYP);
    expect(payload.sub).toBe('U123');
  });

  it('verifyIdJag rejects a grant signed by a different key', async () => {
    const signer = await createIdPKeyPair();
    const other = await createIdPKeyPair();
    const idJag = await createIdJag(signer.privateKey, signer.kid, {
      issuer: 'https://idp.example',
      subject: 'U123',
      audience: 'https://resource-as.example/'
    });
    await expect(verifyIdJag(idJag, other.publicJwk)).rejects.toThrow();
  });

  it('verifyIdJag rejects an expired grant', async () => {
    const kp = await createIdPKeyPair();
    const idJag = await createIdJag(kp.privateKey, kp.kid, {
      issuer: 'https://idp.example',
      subject: 'U123',
      audience: 'https://resource-as.example/',
      expiresIn: '-60s'
    });
    await expect(verifyIdJag(idJag, kp.publicJwk)).rejects.toThrow();
  });

  it('verifyIdJag rejects a JWT with the wrong typ header', async () => {
    const kp = await createIdPKeyPair();
    const notAnIdJag = await new jose.SignJWT({ sub: 'U123' })
      .setProtectedHeader({ alg: ID_JAG_ALG, typ: 'JWT', kid: kp.kid })
      .setIssuer('https://idp.example')
      .setAudience('https://resource-as.example/')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('x')
      .sign(kp.privateKey);
    await expect(verifyIdJag(notAnIdJag, kp.publicJwk)).rejects.toThrow();
  });
});

describe('IdPAuthorizationServer', () => {
  let server: IdPAuthorizationServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('hosts server metadata at the well-known URI retrievable via HTTP GET', async () => {
    server = await IdPAuthorizationServer.create();
    const issuer = await server.start();

    const metadata = await fetchIdPServerMetadata(issuer);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.contentType).toContain('application/json');
    expect(metadata.body.issuer).toBe(issuer);
    expect(metadata.body.jwks_uri).toBe(`${issuer}/jwks`);
    expect(metadata.body.token_endpoint).toBe(`${issuer}/token`);
    expect(metadata.body.grant_types_supported).toContain(
      TOKEN_EXCHANGE_GRANT_TYPE
    );
  });

  it('derives the issuer by removing the well-known suffix from the metadata URL', async () => {
    server = await IdPAuthorizationServer.create();
    const issuer = await server.start();
    expect(server.metadataUrl).toBe(`${issuer}/${OAUTH_AS_WELL_KNOWN}`);
    expect(server.metadataUrl.replace(`/${OAUTH_AS_WELL_KNOWN}`, '')).toBe(
      issuer
    );
  });

  it('serves the signing key at jwks_uri and verifies its own ID-JAG', async () => {
    server = await IdPAuthorizationServer.create();
    await server.start();

    const jwks = await fetchJwks(server.jwksUrl);
    expect(jwks.statusCode).toBe(200);
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key.kty).toBe('EC');
    expect((key as Record<string, unknown>).d).toBeUndefined();

    const idJag = await server.issueIdJag({
      subject: 'U123',
      audience: 'https://resource-as.example/',
      resource: 'https://mcp.example/'
    });
    const { payload } = await verifyIdJag(idJag, key, {
      issuer: server.issuer,
      audience: 'https://resource-as.example/'
    });
    expect(payload.sub).toBe('U123');
    expect(payload.iss).toBe(server.issuer);
  });

  it('throws when the issuer is read before start', async () => {
    server = await IdPAuthorizationServer.create();
    expect(() => server!.issuer).toThrow();
  });

  it('reuses a provided key pair', async () => {
    const kp = await createIdPKeyPair('shared-key');
    server = await IdPAuthorizationServer.create({ keyPair: kp });
    await server.start();
    const jwks = await fetchJwks(server.jwksUrl);
    expect(jwks.keys[0].kid).toBe('shared-key');
  });

  it('advertises a configured issuer while binding to a local port', async () => {
    // Trailing slash is normalised; the local server still serves the routes.
    server = await IdPAuthorizationServer.create({
      issuer: 'https://idp.example.com/'
    });
    await server.start();

    expect(server.issuer).toBe('https://idp.example.com');
    expect(server.localUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(server.jwksUrl).toBe('https://idp.example.com/jwks');
    expect(server.tokenEndpoint).toBe('https://idp.example.com/token');

    // The metadata served at the bound address advertises the configured issuer.
    const metadata = await fetchIdPServerMetadata(server.localUrl);
    expect(metadata.body.issuer).toBe('https://idp.example.com');
    expect(metadata.body.jwks_uri).toBe('https://idp.example.com/jwks');
    expect(metadata.body.token_endpoint).toBe('https://idp.example.com/token');

    // The ID-JAG iss matches the configured issuer, and the key at the bound
    // jwks endpoint verifies it.
    const idJag = await server.issueIdJag({
      subject: 'U123',
      audience: 'https://resource-as.example/',
      resource: 'https://mcp.example/'
    });
    const jwks = await fetchJwks(`${server.localUrl}/jwks`);
    const { payload } = await verifyIdJag(idJag, jwks.keys[0], {
      issuer: 'https://idp.example.com',
      audience: 'https://resource-as.example/'
    });
    expect(payload.iss).toBe('https://idp.example.com');
  });

  it('exposes the configured issuer before start', async () => {
    server = await IdPAuthorizationServer.create({
      issuer: 'https://idp.example.com'
    });
    expect(server.issuer).toBe('https://idp.example.com');
  });

  it('issueIdJagWithUnpublishedKey signs with a key absent from jwks_uri', async () => {
    server = await IdPAuthorizationServer.create();
    await server.start();

    const idJag = await server.issueIdJagWithUnpublishedKey({
      subject: 'U123',
      audience: 'https://resource-as.example/',
      resource: 'https://mcp.example/'
    });

    // iss still names this IdP; only the signing key is unpublished.
    const unverified = jose.decodeJwt(idJag);
    expect(unverified.iss).toBe(server.issuer);

    const jwks = await fetchJwks(server.jwksUrl);
    expect(jwks.keys.map((k) => k.kid)).not.toContain(
      jose.decodeProtectedHeader(idJag).kid
    );
    await expect(
      verifyIdJag(idJag, jwks.keys[0], {
        issuer: server.issuer,
        audience: 'https://resource-as.example/'
      })
    ).rejects.toThrow();
  });
});
