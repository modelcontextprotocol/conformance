import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConformanceCheck } from '../../../../types';
import { SpecReferences } from '../spec-references';

const SCOPES_SEPARATOR = '.scopes.';

/**
 * Append the granted scopes to an opaque test token. The resource server
 * that verifies a token is not always the process that minted it — on
 * serverless hosts (val.town) the token request and the MCP request land on
 * isolates that share no memory — so the token itself carries what the
 * verifier would otherwise look up. Like the flow code in createAuthServer,
 * it is a state carrier for a test fixture, not a credential: nothing signs
 * or checks it.
 */
export function tokenWithScopes(token: string, scopes: string[]): string {
  return `${token}${SCOPES_SEPARATOR}${Buffer.from(scopes.join(' ')).toString('base64url')}`;
}

function scopesFromToken(token: string): string[] | undefined {
  const at = token.lastIndexOf(SCOPES_SEPARATOR);
  if (at < 0) return undefined;
  const scope = Buffer.from(
    token.slice(at + SCOPES_SEPARATOR.length),
    'base64url'
  ).toString();
  return scope ? scope.split(' ') : [];
}

export class MockTokenVerifier implements OAuthTokenVerifier {
  private tokenScopes: Map<string, string[]> = new Map();

  constructor(
    private checks: ConformanceCheck[],
    private expectedScopes: string[] = []
  ) {}

  registerToken(token: string, scopes: string[]) {
    this.tokenScopes.set(token, scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Accept tokens that start with known prefixes
    if (token.startsWith('test-token') || token.startsWith('cc-token')) {
      // Scopes registered in this process, else those the token carries
      // (minted by another process), else none.
      const scopes =
        this.tokenScopes.get(token) ?? scopesFromToken(token) ?? [];

      this.checks.push({
        id: 'valid-bearer-token',
        name: 'ValidBearerToken',
        description: 'Client provided valid bearer token',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE],
        details: {
          token: token.substring(0, 15) + '...',
          scopes
        }
      });
      return {
        token,
        clientId: 'test-client',
        scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      };
    }

    this.checks.push({
      id: 'invalid-bearer-token',
      name: 'InvalidBearerToken',
      description: 'Client provided invalid bearer token',
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE],
      details: {
        message: 'Token verification failed',
        token: token ? token.substring(0, 10) + '...' : 'missing'
      }
    });
    throw new InvalidTokenError('Invalid token');
  }
}
