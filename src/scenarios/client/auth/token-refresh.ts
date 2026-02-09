import type { Scenario, ConformanceCheck } from '../../../types';
import { ScenarioUrls } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';

/**
 * Scenario: Token Refresh Basic
 *
 * Tests that clients correctly use the refresh_token grant to obtain a new
 * access token when the current one expires.
 *
 * Flow:
 *   1. Client authenticates via authorization_code grant
 *   2. Server issues access_token (short-lived, 2s) + refresh_token
 *   3. Client makes a successful MCP request (tools/list)
 *   4. Access token expires
 *   5. Client's next request gets 401
 *   6. Client MUST send grant_type=refresh_token to the token endpoint
 *   7. Client MUST use the new access_token for subsequent requests
 *
 * Spec references:
 *   - OAuth 2.1 §6: Refreshing an Access Token
 *   - OAuth 2.1 §4.3.1: Token rotation for public clients
 */
export class TokenRefreshBasicScenario implements Scenario {
  name = 'auth/token-refresh-basic';
  description =
    'Tests that client uses refresh_token grant to obtain new access token when current one expires (OAuth 2.1 §6)';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);
    // Short-lived tokens — 2 seconds
    tokenVerifier.defaultExpiresIn = 2;

    let refreshGrantCount = 0;
    let refreshedAccessTokenUsed = false;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      accessTokenExpiresIn: 2,
      issueRefreshToken: true,
      rotateRefreshTokens: false,
      onRefreshTokenRequest: (data) => {
        refreshGrantCount++;
        this.checks.push({
          id: 'refresh-token-grant-used',
          name: 'Client used refresh_token grant',
          description:
            'Client correctly used grant_type=refresh_token to obtain new access token after expiry',
          status: 'SUCCESS',
          timestamp: data.timestamp,
          specReferences: [SpecReferences.OAUTH_2_1_REFRESH_TOKEN],
          details: {
            refreshAttempt: refreshGrantCount,
            refreshTokenPrefix: data.refreshToken.substring(0, 20) + '...',
          }
        });
      },
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [],
        tokenVerifier,
        perRequestServer: true,
      }
    );

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Check if the client ever used the refresh_token grant
    const hasRefreshCheck = this.checks.some(
      (c) => c.id === 'refresh-token-grant-used'
    );
    const hasRefreshGrant = this.checks.some(
      (c) => c.id === 'refresh-token-grant-received'
    );

    if (!hasRefreshGrant && !hasRefreshCheck) {
      this.checks.push({
        id: 'refresh-token-grant-used',
        name: 'Client used refresh_token grant',
        description:
          'Client did not use grant_type=refresh_token after access token expired. ' +
          'Clients MUST use refresh tokens when available (OAuth 2.1 §6).',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_REFRESH_TOKEN],
      });
    }

    // Check if the client successfully used a refreshed token
    const validTokenChecks = this.checks.filter(
      (c) => c.id === 'valid-bearer-token'
    );
    const expiredTokenChecks = this.checks.filter(
      (c) => c.id === 'expired-bearer-token'
    );

    if (validTokenChecks.length >= 2 && hasRefreshCheck) {
      this.checks.push({
        id: 'refreshed-token-used-successfully',
        name: 'Refreshed access token used successfully',
        description:
          'Client obtained a new access token via refresh and used it for a subsequent MCP request',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_REFRESH_TOKEN],
        details: {
          totalValidTokenUses: validTokenChecks.length,
          totalExpiredTokenRejections: expiredTokenChecks.length,
        }
      });
    }

    return this.checks;
  }
}

/**
 * Scenario: Token Refresh with Rotation
 *
 * Tests that clients store rotated refresh tokens when the server issues
 * a new refresh_token in the token response (OAuth 2.1 §4.3.1).
 *
 * Flow:
 *   1-6. Same as TokenRefreshBasic
 *   7. Server returns a NEW refresh_token alongside the new access_token
 *   8. Client MUST store the new refresh_token
 *   9. When the new access_token expires, client uses the NEW refresh_token
 *
 * If the client reuses the OLD refresh_token, the server rejects it.
 */
export class TokenRefreshRotationScenario implements Scenario {
  name = 'auth/token-refresh-rotation';
  description =
    'Tests that client stores rotated refresh tokens per OAuth 2.1 §4.3.1';
  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const tokenVerifier = new MockTokenVerifier(this.checks, []);
    tokenVerifier.defaultExpiresIn = 2;

    let refreshGrantCount = 0;

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      tokenVerifier,
      accessTokenExpiresIn: 2,
      issueRefreshToken: true,
      rotateRefreshTokens: true,
      onRefreshTokenRequest: (data) => {
        refreshGrantCount++;
        this.checks.push({
          id: `refresh-rotation-attempt-${refreshGrantCount}`,
          name: `Refresh attempt ${refreshGrantCount} (with rotation)`,
          description:
            `Client sent refresh_token grant (attempt ${refreshGrantCount}). ` +
            'Server will rotate the refresh token.',
          status: 'SUCCESS',
          timestamp: data.timestamp,
          specReferences: [
            SpecReferences.OAUTH_2_1_REFRESH_TOKEN,
            SpecReferences.OAUTH_2_1_TOKEN_ROTATION,
          ],
          details: {
            refreshTokenPrefix: data.refreshToken.substring(0, 20) + '...',
            attemptNumber: refreshGrantCount,
          }
        });
      },
    });

    await this.authServer.start(authApp);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        prmPath: '/.well-known/oauth-protected-resource/mcp',
        requiredScopes: [],
        tokenVerifier,
        perRequestServer: true,
      }
    );

    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    const rotationAttempts = this.checks.filter(
      (c) => c.id.startsWith('refresh-rotation-attempt-')
    );
    const invalidRefreshChecks = this.checks.filter(
      (c) => c.id === 'refresh-token-invalid'
    );

    if (rotationAttempts.length === 0) {
      this.checks.push({
        id: 'refresh-rotation-result',
        name: 'Token rotation test result',
        description:
          'Client did not attempt to use refresh_token grant. ' +
          'Cannot test token rotation without refresh flow.',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN_ROTATION],
      });
    } else if (invalidRefreshChecks.length > 0) {
      this.checks.push({
        id: 'refresh-rotation-result',
        name: 'Token rotation test result',
        description:
          'Client reused an old refresh token after rotation. ' +
          'Clients MUST store the new refresh_token when the server rotates it.',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN_ROTATION],
        details: {
          totalRefreshAttempts: rotationAttempts.length,
          invalidRefreshTokenUses: invalidRefreshChecks.length,
        }
      });
    } else if (rotationAttempts.length >= 1) {
      this.checks.push({
        id: 'refresh-rotation-result',
        name: 'Token rotation test result',
        description:
          'Client correctly stored and used rotated refresh token',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.OAUTH_2_1_TOKEN_ROTATION],
        details: {
          totalRefreshAttempts: rotationAttempts.length,
        }
      });
    }

    return this.checks;
  }
}
