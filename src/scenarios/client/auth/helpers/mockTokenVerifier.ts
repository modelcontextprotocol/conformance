import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConformanceCheck } from '../../../../types';
import { SpecReferences } from '../spec-references';

const SCOPES_SEPARATOR = '.scopes.';

let processKey: Buffer | undefined;

/**
 * The key for a token's scopes MAC: the one given — the hosted server's
 * per-deployment key, shared through its run store (ScenarioContext
 * .tokenMacKey) — or else a random key for this process, which is enough
 * wherever the process that mints a token also verifies it. It is never
 * derived from the relay secret or anything else configured: every token a
 * client receives is a MAC it could try offline guesses against.
 */
function keyOr(key: Buffer | undefined): Buffer {
  return key ?? (processKey ??= randomBytes(32));
}

function mac(payload: string, key: Buffer | undefined): string {
  return createHmac('sha256', keyOr(key)).update(payload).digest('base64url');
}

/**
 * Append the granted scopes to an opaque test token. The resource server
 * that verifies a token is not always the process that minted it — on
 * serverless hosts (val.town) the token request and the MCP request land on
 * isolates that share no memory — so the token itself carries what the
 * verifier would otherwise look up. The scopes are MACed with a key no
 * client sees, so a client cannot grant itself scopes by editing a token;
 * beyond that the token is a test fixture, not a credential.
 */
export function tokenWithScopes(
  token: string,
  scopes: string[],
  key?: Buffer
): string {
  const payload = `${token}${SCOPES_SEPARATOR}${Buffer.from(scopes.join(' ')).toString('base64url')}`;
  return `${payload}.${mac(payload, key)}`;
}

/** The scopes a token carries, if its MAC checks out under `key`. */
function scopesFromToken(
  token: string,
  key: Buffer | undefined
): string[] | undefined {
  const at = token.lastIndexOf(SCOPES_SEPARATOR);
  if (at < 0) return undefined;
  const rest = token.slice(at + SCOPES_SEPARATOR.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return undefined;
  const given = Buffer.from(rest.slice(dot + 1));
  const expected = Buffer.from(
    mac(token.slice(0, at + SCOPES_SEPARATOR.length + dot), key)
  );
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  const scope = Buffer.from(rest.slice(0, dot), 'base64url').toString();
  return scope ? scope.split(' ') : [];
}

export class MockTokenVerifier implements OAuthTokenVerifier {
  private tokenScopes: Map<string, string[]> = new Map();

  constructor(
    private checks: ConformanceCheck[],
    private expectedScopes: string[] = [],
    private macKey?: Buffer
  ) {}

  /** Check carried scopes under `key` (the run's), when there is one. */
  useMacKey(key: Buffer | undefined) {
    if (key) this.macKey = key;
  }

  registerToken(token: string, scopes: string[]) {
    this.tokenScopes.set(token, scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Accept tokens that start with known prefixes
    if (token.startsWith('test-token') || token.startsWith('cc-token')) {
      // Scopes registered in this process, else those the token carries
      // (minted by another process), else none.
      const scopes =
        this.tokenScopes.get(token) ??
        scopesFromToken(token, this.macKey) ??
        [];

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
