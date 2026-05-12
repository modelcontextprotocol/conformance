import * as jose from 'jose';
import type {
  Scenario,
  ConformanceCheck,
  ScenarioUrls,
  ScenarioSpecTag
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import {
  JWT_BEARER_GRANT_TYPE,
  generateWorkloadKeypair,
  createWorkloadJwt
} from './helpers/createWorkloadJwt.js';

const WIF_ISSUER = 'https://wif-idp.conformance-test.local';
const WIF_SUBJECT = 'conformance:test-workload';

export class WifJwtBearerScenario implements Scenario {
  name = 'auth/wif-jwt-bearer';
  specVersions: ScenarioSpecTag[] = ['extension'];
  description =
    'Tests OAuth JWT-bearer grant (RFC 7523 §2.1) for workload identity federation (SEP-1933)';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];

    const { publicKey, privateKey } = await generateWorkloadKeypair();

    const tokenVerifier = new MockTokenVerifier(this.checks);

    const authApp = createAuthServer(this.checks, this.authServer.getUrl, {
      grantTypesSupported: [JWT_BEARER_GRANT_TYPE],
      tokenEndpointAuthMethodsSupported: ['none'],
      tokenEndpointAuthSigningAlgValuesSupported: ['ES256'],
      tokenVerifier,
      onTokenRequest: async ({ grantType, body, timestamp, authBaseUrl }) => {
        if (grantType !== JWT_BEARER_GRANT_TYPE) {
          this.checks.push({
            id: 'wif-grant-type',
            name: 'WifGrantType',
            description: `Expected grant_type=${JWT_BEARER_GRANT_TYPE}, got ${grantType}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });
          return {
            error: 'unsupported_grant_type',
            errorDescription: `Only ${JWT_BEARER_GRANT_TYPE} grant is supported`
          };
        }

        const assertion = body.assertion;
        if (!assertion) {
          this.checks.push({
            id: 'wif-assertion-missing',
            name: 'WifAssertionMissing',
            description:
              'Missing assertion parameter in JWT-bearer token request',
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });
          return {
            error: 'invalid_request',
            errorDescription: 'Missing assertion parameter'
          };
        }

        try {
          const withoutSlash = authBaseUrl.replace(/\/+$/, '');
          const withSlash = `${withoutSlash}/`;
          // iss is not validated here: the keypair is generated per start() call and
          // the public key closure already binds the assertion to this specific run.
          // The scenario exercises client behaviour, not AS issuer policy.
          await jose.jwtVerify(assertion, publicKey, {
            audience: [withoutSlash, withSlash],
            clockTolerance: 5
          });

          this.checks.push({
            id: 'wif-assertion-verified',
            name: 'WifAssertionVerified',
            description:
              'Workload JWT assertion verified — signature, audience, and expiry are valid',
            status: 'SUCCESS',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });

          const scopes = body.scope ? body.scope.split(' ') : [];
          return {
            token: `test-token-${Date.now()}`,
            scopes
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);

          if (e instanceof jose.errors.JWTExpired) {
            this.checks.push({
              id: 'wif-assertion-expired',
              name: 'WifAssertionExpired',
              description: `JWT-bearer assertion is expired: ${msg}`,
              status: 'FAILURE',
              timestamp,
              specReferences: [
                SpecReferences.RFC_7523_JWT_BEARER,
                SpecReferences.SEP_1933_WIF
              ]
            });
            return {
              error: 'invalid_grant',
              errorDescription: 'JWT assertion is expired'
            };
          }

          // JWTExpired extends JWTClaimValidationFailed; check aud specifically so
          // other claim failures (iss, nbf, etc.) fall through to malformed.
          if (
            e instanceof jose.errors.JWTClaimValidationFailed &&
            e.claim === 'aud'
          ) {
            this.checks.push({
              id: 'wif-assertion-audience',
              name: 'WifAssertionAudience',
              description: `JWT-bearer assertion audience claim is invalid: ${msg}`,
              status: 'FAILURE',
              timestamp,
              specReferences: [
                SpecReferences.RFC_7523_JWT_BEARER,
                SpecReferences.SEP_1933_WIF
              ]
            });
            return {
              error: 'invalid_grant',
              errorDescription: 'JWT assertion audience is invalid'
            };
          }

          this.checks.push({
            id: 'wif-assertion-malformed',
            name: 'WifAssertionMalformed',
            description: `JWT-bearer assertion is malformed or has an invalid signature: ${msg}`,
            status: 'FAILURE',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });
          return {
            error: 'invalid_grant',
            errorDescription: `JWT assertion verification failed: ${msg}`
          };
        }
      }
    });

    await this.authServer.start(authApp);

    const authServerUrl = this.authServer.getUrl();

    const [validJwt, wrongAudienceJwt, expiredJwt] = await Promise.all([
      createWorkloadJwt({
        issuer: WIF_ISSUER,
        subject: WIF_SUBJECT,
        audience: authServerUrl,
        privateKey
      }),
      createWorkloadJwt({
        issuer: WIF_ISSUER,
        subject: WIF_SUBJECT,
        audience: 'https://wrong.example',
        privateKey
      }),
      createWorkloadJwt({
        issuer: WIF_ISSUER,
        subject: WIF_SUBJECT,
        audience: authServerUrl,
        privateKey,
        expiresIn: Math.floor(Date.now() / 1000) - 60
      })
    ]);

    const app = createServer(
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { tokenVerifier }
    );

    await this.server.start(app);

    return {
      serverUrl: `${this.server.getUrl()}/mcp`,
      context: {
        issuer: WIF_ISSUER,
        subject: WIF_SUBJECT,
        audience: authServerUrl,
        valid_jwt: validJwt,
        wrong_audience_jwt: wrongAudienceJwt,
        expired_jwt: expiredJwt,
        signing_algorithm: 'ES256'
      }
    };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    const hasVerifiedCheck = this.checks.some(
      (c) => c.id === 'wif-assertion-verified'
    );
    if (!hasVerifiedCheck) {
      this.checks.push({
        id: 'wif-assertion-verified',
        name: 'WifAssertionVerified',
        description: 'Client did not make a JWT-bearer token request',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.RFC_7523_JWT_BEARER,
          SpecReferences.SEP_1933_WIF
        ]
      });
    }
    return this.checks;
  }
}
