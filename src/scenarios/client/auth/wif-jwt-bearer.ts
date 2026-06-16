import * as jose from 'jose';
import type {
  Scenario,
  ConformanceCheck,
  ScenarioUrls,
  SpecVersion
} from '../../../types';
import type { ScenarioContext } from '../../../mock-server';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { MockTokenVerifier } from './helpers/mockTokenVerifier';
import { ServerLifecycle } from './helpers/serverLifecycle';
import { SpecReferences } from './spec-references';
import {
  JWT_BEARER_GRANT_TYPE,
  WIF_TRIGGER_UNAUTHORIZED_SCOPE,
  WIF_REJECTED_SCOPE,
  generateWorkloadKeypair,
  createWorkloadJwt
} from './helpers/createWorkloadJwt.js';

const WIF_ISSUER = 'https://idp.conformance-test.local';
const WIF_SUBJECT = 'conformance-workload';
const WIF_CLIENT_ID = 'conformance-wif-workload';

export class WifJwtBearerScenario implements Scenario {
  name = 'auth/wif-jwt-bearer';
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests the RFC 7523 JWT-bearer grant for workload identity federation (SEP-1933). ' +
    'The client must: use grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer, ' +
    'include the workload JWT as the assertion parameter, and surface errors ' +
    '(invalid_grant, invalid_scope, unauthorized_client) without retrying or switching grant types.';

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private tokenRequestReceived = false;
  private failedOnce = false;

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    this.tokenRequestReceived = false;
    this.failedOnce = false;

    const { publicKey, privateKey } = await generateWorkloadKeypair();

    const tokenVerifier = new MockTokenVerifier(this.checks);

    const authApp = createAuthServer(ctx, this.checks, this.authServer.getUrl, {
      grantTypesSupported: [JWT_BEARER_GRANT_TYPE],
      tokenEndpointAuthMethodsSupported: ['none'],
      tokenVerifier,
      disableDynamicRegistration: true,
      onTokenRequest: async ({ grantType, body, timestamp, authBaseUrl }) => {
        // wif-no-retry and wif-grant-fallback fire on any second request after
        // any first failure, not only after unauthorized_client specifically.
        if (this.tokenRequestReceived && this.failedOnce) {
          if (grantType !== JWT_BEARER_GRANT_TYPE) {
            this.checks.push({
              id: 'wif-grant-fallback',
              name: 'WifGrantFallback',
              description: `Client fell back to ${grantType} grant after a JWT-bearer token request was rejected; clients should not switch grant types after a JWT-bearer failure`,
              status: 'WARNING',
              timestamp,
              specReferences: [
                SpecReferences.RFC_7523_JWT_BEARER,
                SpecReferences.SEP_1933_WIF
              ]
            });
            return {
              error: 'unsupported_grant_type',
              errorDescription: 'Only JWT-bearer grant is supported'
            };
          }
          this.checks.push({
            id: 'wif-no-retry',
            name: 'WifNoRetry',
            description:
              'Client retried JWT-bearer token request after a failure instead of giving up',
            status: 'WARNING',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });
          return {
            error: 'invalid_request',
            errorDescription: 'Retry not allowed for JWT-bearer grant'
          };
        }
        this.tokenRequestReceived = true;
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
          this.failedOnce = true;
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
          this.failedOnce = true;
          return {
            error: 'invalid_request',
            errorDescription: 'Missing assertion parameter'
          };
        }

        try {
          const withoutSlash = authBaseUrl.replace(/\/+$/, '');
          const withSlash = `${withoutSlash}/`;
          // iss is not validated: the keypair is generated per start() call and
          // the public key closure binds the assertion to this run. This scenario
          // tests client behaviour, not AS issuer policy.
          // clockTolerance of 5s is sufficient because JWTs are signed and consumed
          // within the same test run; skew from a real IdP is not a factor here.
          // Both slash forms are accepted because the SDK constructs the audience
          // from the AS metadata URL, which may or may not carry a trailing slash
          // depending on how the metadata endpoint was discovered.
          await jose.jwtVerify(assertion, publicKey, {
            audience: [withoutSlash, withSlash],
            clockTolerance: 5
          });

          this.checks.push({
            id: 'wif-assertion-verified',
            name: 'WifAssertionVerified',
            description:
              'Workload JWT assertion verified — signature, audience, and expiry are valid (iss not validated; keypair is run-scoped)',
            status: 'SUCCESS',
            timestamp,
            specReferences: [
              SpecReferences.RFC_7523_JWT_BEARER,
              SpecReferences.SEP_1933_WIF
            ]
          });

          const scopeList = body.scope ? body.scope.split(' ') : [];
          if (scopeList.includes(WIF_TRIGGER_UNAUTHORIZED_SCOPE)) {
            this.failedOnce = true;
            return {
              error: 'unauthorized_client',
              errorDescription: 'Client not authorized for JWT-bearer grant'
            };
          }
          if (scopeList.includes(WIF_REJECTED_SCOPE)) {
            this.failedOnce = true;
            return {
              error: 'invalid_scope',
              errorDescription:
                'Requested scope is not permitted for this grant'
            };
          }
          return {
            token: `test-token-${Date.now()}`,
            scopes: scopeList
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
            this.failedOnce = true;
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
            this.failedOnce = true;
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
          this.failedOnce = true;
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
        // Absolute epoch seconds in the past; jose treats a number as an absolute
        // epoch timestamp, producing a token that is already expired.
        expiresIn: '-60s'
      })
    ]);

    const app = createServer(
      ctx,
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      { tokenVerifier }
    );

    await this.server.start(app);

    return {
      serverUrl: `${this.server.getUrl()}/mcp`,
      context: {
        client_id: WIF_CLIENT_ID,
        valid_jwt: validJwt,
        wrong_audience_jwt: wrongAudienceJwt,
        expired_jwt: expiredJwt
      }
    };
  }

  async stop() {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    if (!this.tokenRequestReceived) {
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
