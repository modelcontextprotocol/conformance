import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { MockTokenVerifier, tokenWithScopes } from './mockTokenVerifier';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

const verify = async (token: string) =>
  (await new MockTokenVerifier([]).verifyAccessToken(token)).scopes;

describe('the scopes MAC key', () => {
  const saved = process.env.CONFORMANCE_RELAY_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONFORMANCE_RELAY_SECRET;
    else process.env.CONFORMANCE_RELAY_SECRET = saved;
  });

  // A token is a MAC a client could run offline guesses against, so the
  // relay secret that guards /__aux must never be its key.
  it.each([
    ['a long', 'x'.repeat(64)],
    ['a short', 'short-secret']
  ])('is never %s relay secret itself', async (_, secret) => {
    process.env.CONFORMANCE_RELAY_SECRET = secret;
    const token = tokenWithScopes('test-token-2', ['mcp:basic']);
    const cut = token.lastIndexOf('.');
    expect(token.slice(cut + 1)).not.toBe(
      createHmac('sha256', secret)
        .update(token.slice(0, cut))
        .digest('base64url')
    );
    expect(await verify(token)).toEqual(['mcp:basic']);
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
