import { describe, it, expect, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'crypto';
import { MockTokenVerifier, tokenWithScopes } from './mockTokenVerifier';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

const verify = async (token: string, key?: Buffer) =>
  (await new MockTokenVerifier([], [], key).verifyAccessToken(token)).scopes;

const macWith = (key: Buffer | string, payload: string) =>
  createHmac('sha256', key).update(payload).digest('base64url');

describe('the scopes MAC key', () => {
  const saved = process.env.CONFORMANCE_RELAY_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONFORMANCE_RELAY_SECRET;
    else process.env.CONFORMANCE_RELAY_SECRET = saved;
  });

  // Every token a client receives is a MAC it could run offline guesses
  // against, so no key may depend on the relay secret, however long.
  it('never verifies a token signed with the relay secret or a key derived from it', async () => {
    const secret = 'x'.repeat(64);
    process.env.CONFORMANCE_RELAY_SECRET = secret;
    const payload = `test-token-2.scopes.${b64('mcp:admin')}`;
    const derived = createHmac('sha256', secret)
      .update('mcp-conformance/token-scopes')
      .digest();
    for (const key of [secret, derived]) {
      const token = `${payload}.${macWith(key, payload)}`;
      expect(await verify(token)).toEqual([]);
    }
  });

  it("checks carried scopes under the run's key", async () => {
    const key = randomBytes(32);
    const token = tokenWithScopes('test-token-3', ['mcp:basic'], key);
    expect(await verify(token, key)).toEqual(['mcp:basic']);
    expect(await verify(token, randomBytes(32))).toEqual([]);
    expect(await verify(token)).toEqual([]);
  });
});

describe('MockTokenVerifier with tokens minted by another process', () => {
  it('reads the scopes a minted token carries', async () => {
    expect(
      await verify(tokenWithScopes('test-token-1', ['mcp:basic']))
    ).toEqual(['mcp:basic']);
  });

  it('ignores scopes a client wrote into the token itself', async () => {
    const forged = `test-token-1.scopes.${b64('mcp:admin')}`;
    const edited = tokenWithScopes('test-token-1', ['mcp:basic']).replace(
      b64('mcp:basic'),
      b64('mcp:admin')
    );
    expect(await verify(forged)).toEqual([]);
    expect(await verify(edited)).toEqual([]);
  });
});
