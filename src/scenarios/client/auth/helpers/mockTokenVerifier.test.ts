import { describe, it, expect } from 'vitest';
import { MockTokenVerifier, tokenWithScopes } from './mockTokenVerifier';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** A verifier in another process: it never saw the token minted. */
const scopesSeenElsewhere = async (token: string) =>
  (await new MockTokenVerifier([]).verifyAccessToken(token)).scopes;

/**
 * Test access tokens carry their scopes in plain text, so a resource server
 * in any process reads them. They are fixtures, not credentials: nothing
 * signs them, and a client that edits its own only misleads its own report.
 */
describe('test access tokens', () => {
  it('show their scopes to a process that did not mint them', async () => {
    const token = tokenWithScopes('test-token-1', ['mcp:basic', 'mcp:write']);
    expect(await scopesSeenElsewhere(token)).toEqual([
      'mcp:basic',
      'mcp:write'
    ]);
  });

  it('take their scopes from the suffix as written, edits included', async () => {
    const edited = tokenWithScopes('test-token-1', ['mcp:basic']).replace(
      b64('mcp:basic'),
      b64('mcp:admin')
    );
    expect(await scopesSeenElsewhere(edited)).toEqual(['mcp:admin']);
  });
});
