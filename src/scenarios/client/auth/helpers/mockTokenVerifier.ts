import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ConformanceCheck } from '../../../../types.js';
import { SpecReferences } from '../spec-references.js';

export class MockTokenVerifier implements OAuthTokenVerifier {
  constructor(private checks: ConformanceCheck[]) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === 'test-token') {
      this.checks.push({
        id: 'valid-bearer-token',
        name: 'ValidBearerToken',
        description: 'Client provided valid bearer token',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_ACCESS_TOKEN_USAGE],
        details: {
          token: token.substring(0, 10) + '...'
        }
      });
      return {
        token,
        clientId: 'test-client',
        scopes: [],
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
    throw new Error('Invalid token');
  }
}
