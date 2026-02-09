import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConformanceCheck } from '../../../../types';
import { SpecReferences } from '../spec-references';

interface TokenEntry {
  scopes: string[];
  /** Unix timestamp (seconds) when the token was issued. */
  issuedAt: number;
  /** Token lifetime in seconds. */
  expiresIn: number;
}

export class MockTokenVerifier implements OAuthTokenVerifier {
  private tokenEntries: Map<string, TokenEntry> = new Map();

  /**
   * Default token lifetime for registerToken calls that don't specify one.
   * Set to a small value for token refresh lifecycle tests.
   */
  public defaultExpiresIn = 3600;

  constructor(
    private checks: ConformanceCheck[],
    private expectedScopes: string[] = []
  ) {}

  registerToken(token: string, scopes: string[], expiresIn?: number) {
    this.tokenEntries.set(token, {
      scopes,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: expiresIn ?? this.defaultExpiresIn,
    });
  }

  /** Legacy getter for code that reads token scopes directly. */
  get tokenScopes(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [token, entry] of this.tokenEntries) {
      result.set(token, entry.scopes);
    }
    return result;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Accept tokens that start with known prefixes
    if (token.startsWith('test-token') || token.startsWith('cc-token')) {
      const entry = this.tokenEntries.get(token);
      const scopes = entry?.scopes || [];

      // Check expiration if entry exists with a finite lifetime
      if (entry) {
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = entry.issuedAt + entry.expiresIn;
        if (now > expiresAt) {
          this.checks.push({
            id: 'expired-bearer-token',
            name: 'ExpiredBearerToken',
            description: 'Client presented an expired access token',
            status: 'INFO',
            timestamp: new Date().toISOString(),
            specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE],
            details: {
              token: token.substring(0, 15) + '...',
              expiredSecondsAgo: now - expiresAt,
            }
          });
          throw new InvalidTokenError('Token expired');
        }
      }

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

      const expiresAt = entry
        ? entry.issuedAt + entry.expiresIn
        : Math.floor(Date.now() / 1000) + 3600;

      return {
        token,
        clientId: 'test-client',
        scopes,
        expiresAt,
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
