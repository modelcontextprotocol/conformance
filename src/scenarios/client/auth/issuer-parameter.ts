import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../../types.js';
import { createAuthServer } from './helpers/createAuthServer.js';
import { createServer } from './helpers/createServer.js';
import { SpecReferences } from './spec-references.js';
import { MockTokenVerifier } from './helpers/mockTokenVerifier.js';
import { untestableCheck } from '../../untestable.js';

const specRefs = [
  SpecReferences.RFC_9207_ISS_PARAMETER,
  SpecReferences.MCP_AUTH_RESPONSE_VALIDATION_2026_07_28
];
const metadataSpecRefs = [
  SpecReferences.RFC_AUTH_SERVER_METADATA_REQUEST,
  SpecReferences.MCP_AUTH_DISCOVERY_2026_07_28
];

/**
 * What the flow reached, read from the log: the mock servers record every
 * metadata fetch, registration, authorization and token request. Verdicts
 * read these rather than flags set as requests arrive, so a fresh instance
 * judging a merged log (the hosted server, across processes) reaches the
 * same verdict as the instance that served the flow.
 */
function logged(checks: ConformanceCheck[], id: string): boolean {
  return checks.some((c) => c.id === id);
}

/** The issuer the AS metadata document declared, as createAuthServer logged it. */
function declaredIssuer(checks: ConformanceCheck[]): string | undefined {
  const issuer = checks.find((c) => c.id === 'authorization-server-metadata')
    ?.details?.issuer;
  return typeof issuer === 'string' ? issuer : undefined;
}

/** The authorization server the PRM document sent the client to. */
function advertisedAuthorizationServer(
  checks: ConformanceCheck[]
): string | undefined {
  const servers = checks.find((c) => c.id === 'prm-pathbased-requested')
    ?.details?.authorizationServers;
  return Array.isArray(servers) && typeof servers[0] === 'string'
    ? servers[0]
    : undefined;
}

/** The token every scenario here issues; none of them requests scopes. */
const issueToken = () => ({ token: `test-token-${Date.now()}`, scopes: [] });

/**
 * Reason-bound verdict for the RFC 9207 `iss` rejection checks (issue #467).
 *
 * `authReached && !tokenRequestMade` is a verdict, not a reason. SEP-2468
 * conditions every one of these requirements on the issuer the client recorded
 * "from the selected authorization server validated metadata document", so a
 * client that never retrieved that document cannot have performed the
 * comparison under test — yet it satisfies the verdict, because not reaching
 * the token endpoint is exactly what a client that fell over earlier also
 * does. Absent the retrieval the requirement was never exercised, which is the
 * untestable case (#248) rather than a pass or a violation.
 *
 * `auth/metadata-issuer-mismatch` in this same file already gates on the
 * metadata fetch; the other checks did not. Keeping the policy in one function
 * is deliberate: the duplication is what let five of six sites drift apart.
 *
 * Residual gap, deliberately not papered over: a client that receives the
 * redirect and then aborts before the token request for an unrelated reason is
 * still indistinguishable from one that rejected on `iss`. Closing that needs
 * a signal from inside the client, which a black-box harness does not have.
 * What this closes is the "never reached the requirement at all" class.
 */
function issRejectionCheck(opts: {
  id: string;
  name: string;
  passDescription: string;
  failDescription: string;
  metadataRequested: boolean;
  authReached: boolean;
  tokenRequestMade: boolean;
  observations: Record<string, unknown>;
  timestamp: string;
}): ConformanceCheck {
  const {
    id,
    name,
    passDescription,
    failDescription,
    metadataRequested,
    authReached,
    tokenRequestMade,
    observations,
    timestamp
  } = opts;

  const reached = metadataRequested && authReached;
  const observed = {
    ...observations,
    metadataRequested,
    authReached,
    tokenRequestMade
  };

  if (!reached) {
    const reason = !metadataRequested
      ? 'client never retrieved the authorization server metadata document, so it never recorded the issuer this comparison is made against'
      : 'client never reached the authorization endpoint, so it never received an authorization response to validate';
    const check = untestableCheck(id, name, failDescription, reason, specRefs);
    check.details = {
      ...check.details,
      ...observed,
      propertyReached: false,
      stopReason: !metadataRequested
        ? 'as-metadata-not-requested'
        : 'authorization-endpoint-not-reached'
    };
    return check;
  }

  const correctlyRejected = !tokenRequestMade;
  return {
    id,
    name,
    description: correctlyRejected ? passDescription : failDescription,
    status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
    timestamp,
    specReferences: specRefs,
    details: {
      ...observed,
      propertyReached: true,
      stopReason: correctlyRejected
        ? 'declined-before-token-request'
        : 'transmitted-code-to-token-endpoint'
    }
  };
}

/** Where the iss rejection verdicts read the flow from: the log. */
function issFlow(checks: ConformanceCheck[]) {
  return {
    metadataRequested: logged(checks, 'authorization-server-metadata'),
    authReached: logged(checks, 'authorization-request'),
    tokenRequestMade: logged(checks, 'token-request')
  };
}

/**
 * Scenario: ISS Parameter Supported (positive)
 *
 * Server advertises authorization_response_iss_parameter_supported: true and
 * includes the correct iss value in the authorization redirect. A conformant
 * client should validate iss and proceed normally.
 */
export class IssParameterSupportedScenario extends AuthHandlerScenario {
  name = 'auth/iss-supported';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client accepts authorization response when server advertises and sends correct iss parameter';

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'correct',
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();
    const tokenRequestMade = logged(this.checks, 'token-request');

    checks.push({
      id: 'sep-2468-client-compare-iss-supported',
      name: 'Client accepts matching iss when advertised',
      description: tokenRequestMade
        ? 'Client compared advertised iss against recorded issuer and proceeded to token exchange'
        : 'Client did not proceed to token exchange after receiving a correct iss from a server that advertised support',
      status: tokenRequestMade ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: { tokenRequestMade }
    });

    return checks;
  }
}

/**
 * Scenario: ISS Parameter Not Advertised (positive)
 *
 * Server does not advertise authorization_response_iss_parameter_supported and
 * does not include iss in the redirect. A conformant client should proceed normally.
 */
export class IssParameterNotAdvertisedScenario extends AuthHandlerScenario {
  name = 'auth/iss-not-advertised';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client accepts authorization response when server does not advertise or send iss parameter';

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: null,
      issInRedirect: 'omit',
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();
    const tokenRequestMade = logged(this.checks, 'token-request');

    checks.push({
      id: 'sep-2468-client-proceed-no-iss',
      name: 'Client proceeds when iss absent and not advertised',
      description: tokenRequestMade
        ? 'Client proceeded to token exchange when neither metadata advertised iss support nor redirect contained iss'
        : 'Client did not proceed to token exchange — should proceed when iss is absent and not advertised',
      status: tokenRequestMade ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: { tokenRequestMade }
    });

    return checks;
  }
}

/**
 * Scenario: ISS Parameter Advertised but Missing from Redirect (client must reject)
 *
 * Server advertises authorization_response_iss_parameter_supported: true but
 * omits iss from the redirect. A conformant client MUST reject this response.
 */
export class IssParameterSupportedMissingScenario extends AuthHandlerScenario {
  name = 'auth/iss-supported-missing';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client rejects authorization response when server advertised iss support but omitted iss from redirect';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'omit', // advertise support but don't send iss
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (!checks.some((c) => c.id === 'sep-2468-client-reject-missing-iss')) {
      checks.push(
        issRejectionCheck({
          id: 'sep-2468-client-reject-missing-iss',
          name: 'Client rejects missing iss when required',
          passDescription:
            'Client correctly rejected authorization response missing required iss parameter',
          failDescription:
            'Client MUST reject authorization response when server advertised iss support but iss is absent from redirect',
          ...issFlow(this.checks),
          observations: {
            serverAdvertisedSupport: true,
            issSentInRedirect: false
          },
          timestamp
        })
      );
    }

    return checks;
  }
}

/**
 * Scenario: ISS Parameter Has Wrong Value (client must reject)
 *
 * Server advertises authorization_response_iss_parameter_supported: true and
 * includes an iss value that does not match the server's actual issuer. A
 * conformant client MUST reject this response.
 */
export class IssParameterWrongIssuerScenario extends AuthHandlerScenario {
  name = 'auth/iss-wrong-issuer';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client rejects authorization response when iss does not match the authorization server issuer';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'wrong', // send iss that doesn't match metadata issuer
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (!checks.some((c) => c.id === 'sep-2468-client-compare-iss-supported')) {
      checks.push(
        issRejectionCheck({
          id: 'sep-2468-client-compare-iss-supported',
          name: 'Client rejects mismatched iss',
          passDescription:
            'Client correctly rejected authorization response with mismatched iss parameter',
          failDescription:
            'Client MUST reject authorization response when iss does not match the authorization server issuer',
          ...issFlow(this.checks),
          observations: {
            serverAdvertisedSupport: true,
            issSentInRedirect: 'https://evil.example.com'
          },
          timestamp
        })
      );
    }

    return checks;
  }
}

/**
 * Scenario: ISS Parameter Sent but Not Advertised, Mismatched (client must reject)
 *
 * Server does not advertise authorization_response_iss_parameter_supported but
 * includes a mismatched iss value in the redirect. Per the SEP-2468 spec table
 * row 3, a conformant client MUST compare a present iss against the recorded
 * issuer regardless of metadata advertisement, and reject on mismatch.
 */
export class IssParameterUnexpectedScenario extends AuthHandlerScenario {
  name = 'auth/iss-unexpected';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client compares iss against recorded issuer even when not advertised, and rejects on mismatch';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: null,
      issInRedirect: 'wrong', // send mismatched iss without advertising support
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (
      !checks.some((c) => c.id === 'sep-2468-client-compare-iss-unadvertised')
    ) {
      checks.push(
        issRejectionCheck({
          id: 'sep-2468-client-compare-iss-unadvertised',
          name: 'Client compares unadvertised iss and rejects mismatch',
          passDescription:
            'Client correctly compared unadvertised iss against recorded issuer and rejected the mismatch',
          failDescription:
            'Client MUST compare a present iss against the recorded issuer regardless of metadata advertisement, and reject on mismatch',
          ...issFlow(this.checks),
          observations: {
            serverAdvertisedSupport: false,
            issSentInRedirect: 'https://evil.example.com'
          },
          timestamp
        })
      );
    }

    return checks;
  }
}

/**
 * Scenario: ISS Parameter Is a Normalization-Equivalent Variant (client must reject)
 *
 * Server advertises authorization_response_iss_parameter_supported: true and
 * includes an iss value that differs from the recorded issuer only by RFC 3986
 * normalization (a trailing slash on an empty path — exactly what
 * `new URL(x).href` round-tripping produces). SEP-2468 requires simple string
 * comparison with no scheme/host case folding, default-port elision,
 * trailing-slash, or percent-encoding normalization, so a conformant client
 * MUST treat the variant as a mismatch and reject the response.
 */
export class IssParameterNormalizedVariantScenario extends AuthHandlerScenario {
  name = 'auth/iss-normalized';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client compares iss using simple string comparison without applying URL normalization';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      issParameterSupported: true,
      issInRedirect: 'normalized', // correct issuer + trailing slash
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (!checks.some((c) => c.id === 'sep-2468-client-no-normalization')) {
      // The issuer as the log shows it; a client that never fetched the
      // metadata document never recorded one, and neither does the check.
      const recordedIssuer = declaredIssuer(this.checks);
      checks.push(
        issRejectionCheck({
          id: 'sep-2468-client-no-normalization',
          name: 'Client compares iss without URL normalization',
          passDescription:
            'Client rejected an iss value that only matches the recorded issuer after URL normalization',
          failDescription:
            'Client MUST NOT apply scheme/host case folding, default-port elision, trailing-slash, or percent-encoding normalization to iss before comparison; a trailing-slash variant of the issuer must be treated as a mismatch',
          ...issFlow(this.checks),
          observations:
            recordedIssuer === undefined
              ? {}
              : { recordedIssuer, issSentInRedirect: `${recordedIssuer}/` },
          timestamp
        })
      );
    }

    return checks;
  }
}

/**
 * Scenario: AS Metadata Issuer Mismatch (client must not use the metadata)
 *
 * The authorization server metadata document declares an `issuer` that is not
 * identical to the issuer identifier used to construct the well-known URL.
 * Per RFC 8414 §3.3 / OpenID Connect Discovery §4.3 (incorporated by
 * SEP-2468), the client MUST validate the issuer and MUST NOT use the
 * metadata on mismatch. The endpoints in the poisoned document live under a
 * non-default route prefix, so any request that reaches them proves the
 * client used the metadata.
 */
export class MetadataIssuerMismatchScenario extends AuthHandlerScenario {
  name = 'auth/metadata-issuer-mismatch';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests that client rejects authorization server metadata whose issuer does not match the issuer used to construct the well-known URL';
  allowClientError = true;

  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const tokenVerifier = new MockTokenVerifier(this.checks, []);

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      tokenVerifier,
      // The well-known URL is constructed from the AS URL advertised in PRM
      // (the bare origin), so the document's issuer must equal that origin.
      // Serve something else entirely.
      metadataIssuer: 'https://attacker.example.com',
      // Park the endpoints under a prefix only discoverable via the poisoned
      // metadata, so "client used the metadata" is observable as a request.
      routePrefix: '/mismatched-as',
      onRegistrationRequest: () => ({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret'
      }),
      onTokenRequest: issueToken
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl, {
      requiredScopes: [],
      tokenVerifier
    });

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    const checks = [...this.checks];
    const timestamp = new Date().toISOString();

    if (
      !checks.some((c) => c.id === 'sep-2468-client-validate-metadata-issuer')
    ) {
      const metadataRequested = logged(
        this.checks,
        'authorization-server-metadata'
      );
      // Any request to the endpoints the poisoned document names.
      const metadataEndpointsUsed = [
        'client-registration',
        'authorization-request',
        'token-request'
      ].some((id) => logged(this.checks, id));
      // The issuer the PRM sent the client to, when the log shows it.
      const expectedIssuer = advertisedAuthorizationServer(this.checks);
      const observations = {
        ...(expectedIssuer !== undefined && { expectedIssuer }),
        metadataIssuer: 'https://attacker.example.com',
        metadataRequested,
        metadataEndpointsUsed
      };
      const failDescription =
        'Client MUST NOT use authorization server metadata whose issuer differs from the issuer identifier used to construct the well-known URL; client used endpoints from the mismatched metadata';

      // This check already bound its verdict to the metadata fetch, but
      // reported the unreached case as a plain violation. Per #248 a
      // requirement that could not be exercised is untestable, so the report
      // distinguishes "client used the poisoned metadata" from "client never
      // fetched it" instead of collapsing both into FAILURE (#467).
      if (!metadataRequested) {
        const check = untestableCheck(
          'sep-2468-client-validate-metadata-issuer',
          'Client validates metadata issuer against well-known URL',
          failDescription,
          'client never retrieved the authorization server metadata document, so issuer validation could not be observed',
          metadataSpecRefs
        );
        check.details = {
          ...check.details,
          ...observations,
          propertyReached: false,
          stopReason: 'as-metadata-not-requested'
        };
        checks.push(check);
      } else {
        const correctlyRejected = !metadataEndpointsUsed;
        checks.push({
          id: 'sep-2468-client-validate-metadata-issuer',
          name: 'Client validates metadata issuer against well-known URL',
          description: correctlyRejected
            ? 'Client rejected authorization server metadata whose issuer does not match the issuer identifier used to construct the well-known URL'
            : failDescription,
          status: correctlyRejected ? 'SUCCESS' : 'FAILURE',
          timestamp,
          specReferences: metadataSpecRefs,
          details: {
            ...observations,
            propertyReached: true,
            stopReason: correctlyRejected
              ? 'declined-poisoned-metadata'
              : 'used-poisoned-metadata-endpoints'
          }
        });
      }
    }

    return checks;
  }
}
