import { describe, it, expect } from 'vitest';
import { MockTokenVerifier, tokenWithScopes } from './mockTokenVerifier';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('MockTokenVerifier with tokens minted by another process', () => {
  const verify = async (token: string) =>
    (await new MockTokenVerifier([]).verifyAccessToken(token)).scopes;

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
