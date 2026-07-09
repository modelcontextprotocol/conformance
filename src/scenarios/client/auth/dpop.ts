import type { ScenarioContext } from '../../../mock-server';
import type {
  Scenario,
  ConformanceCheck,
  CheckStatus,
  SpecReference
} from '../../../types';
import { ScenarioUrls } from '../../../types';
import {
  createAuthServer,
  type DpopTokenRequestObservation
} from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { ServerLifecycle } from './helpers/serverLifecycle';
import {
  createDpopResourceAuth,
  newDpopClientObservations,
  type DpopClientObservations
} from './helpers/dpopResourceAuth';
import { DPOP_ASYMMETRIC_ALGS } from './helpers/dpopAlgs';
import { SpecReferences } from './spec-references';

const PRM_PATH = '/.well-known/oauth-protected-resource/mcp';

/** Static id → (name, description, spec references) for each emitted check. */
const CHECK_DEFS: Record<
  string,
  { name: string; description: string; specReferences: SpecReference[] }
> = {
  'sep-1932-client-dpop-auth-scheme': {
    name: 'DpopAuthScheme',
    description:
      'Client presents the access token with the DPoP Authorization scheme (not Bearer)',
    specReferences: [
      SpecReferences.SEP_1932_DPOP,
      SpecReferences.DPOP_EXTENSION,
      SpecReferences.RFC_9449_AUTH_SCHEME
    ]
  },
  'sep-1932-client-fresh-proof': {
    name: 'DpopFreshProof',
    description:
      'Client includes a fresh, well-formed DPoP proof in the DPoP header on each MCP POST request',
    specReferences: [
      SpecReferences.RFC_9449_CHECKING_PROOFS,
      SpecReferences.RFC_9449_PROOF_SYNTAX,
      SpecReferences.DPOP_EXTENSION
    ]
  },
  'sep-1932-client-token-request-proof': {
    name: 'DpopTokenRequestProof',
    description:
      'Client includes a valid DPoP proof in the DPoP header of its token request — the prerequisite for obtaining a DPoP-bound access token (RFC 9449 §5)',
    specReferences: [
      SpecReferences.SEP_1932_DPOP,
      SpecReferences.DPOP_EXTENSION,
      SpecReferences.RFC_9449_TOKEN_REQUEST
    ]
  },
  'sep-1932-client-as-nonce': {
    name: 'DpopAsNonce',
    description:
      'On a use_dpop_nonce challenge from the token endpoint, the client retries the token request with the server-supplied nonce (RFC 9449 §8)',
    specReferences: [
      SpecReferences.SEP_1932_DPOP,
      SpecReferences.DPOP_EXTENSION,
      SpecReferences.RFC_9449_AS_NONCE
    ]
  },
  'sep-1932-client-rs-nonce': {
    name: 'DpopRsNonce',
    description:
      'On a use_dpop_nonce challenge from the MCP server, the client retries the request with the server-supplied nonce (RFC 9449 §9)',
    specReferences: [
      SpecReferences.SEP_1932_DPOP,
      SpecReferences.DPOP_EXTENSION,
      SpecReferences.RFC_9449_RS_NONCE
    ]
  }
};

/**
 * Scenario: DPoP sender-constrained tokens — MCP client (SEP-1932 / RFC 9449).
 *
 * The test authorization server (DPoP-capable `createAuthServer`) issues a
 * DPoP-bound token; the test MCP server judges how the client presents it.
 *
 * Registered in two postures, because server-provided nonces are OPTIONAL in
 * RFC 9449 (AS §8 "MAY", RS §9 "can also choose") and the two are mutually
 * exclusive for a given run:
 *
 *  - `auth/dpop` (`requireNonce = false`) — the common, nonce-less baseline.
 *    Neither the AS nor the MCP server issues a nonce challenge; the client
 *    completes the flow with plain proofs. Emits three checks:
 *      · token acquisition — a valid DPoP proof at the token request, obtaining
 *        a sender-constrained token (RFC 9449 §5);
 *      · the token is presented with the `DPoP` Authorization scheme (§7.1);
 *      · a fresh, well-formed DPoP proof accompanies each request (unique `jti`).
 *
 *  - `auth/dpop-nonce` (`requireNonce = true`) — the AS and MCP server both
 *    require a server-provided nonce (§8/§9), exercising the client's nonce
 *    handling. Emits the three baseline checks plus two more:
 *      · the client retries the token request with the AS-supplied nonce (§8);
 *      · the client retries the MCP request with the server-supplied nonce (§9).
 */
function newTokenReqObs(): DpopTokenRequestObservation {
  return {
    recorded: false,
    validProof: false,
    asNonceChallengeIssued: false,
    asNonceHonored: false
  };
}

/**
 * Collapse duplicate non-INFO check IDs to a single entry, preferring the
 * MOST-SEVERE occurrence (FAILURE > WARNING > SUCCESS > any other status, e.g.
 * SKIPPED) so a real failure is never masked. Equal-severity ties keep the LAST
 * occurrence (for the nonce round-trip that is the retry's diagnostic, which is
 * status-equivalent to the first). Per-request INFO log entries are always kept.
 *
 * The RFC 9449 §8/§9 nonce round-trip re-POSTs /token (challenge → retry), so
 * the shared token-flow conformance checks (`token-request`, `pkce-*`) are
 * appended twice; this reports each once without hiding a failure recorded on
 * either attempt. Exported so the behaviour is unit-tested directly.
 */
export function collapseDuplicateChecks(
  checks: ConformanceCheck[]
): ConformanceCheck[] {
  const severity = (s: CheckStatus): number =>
    s === 'FAILURE' ? 3 : s === 'WARNING' ? 2 : s === 'SUCCESS' ? 1 : 0;
  // Winning index per non-INFO id: highest severity, ties → last occurrence.
  const winner = new Map<string, number>();
  checks.forEach((c, i) => {
    if (c.status === 'INFO') return;
    const cur = winner.get(c.id);
    if (
      cur === undefined ||
      severity(c.status) >= severity(checks[cur].status)
    ) {
      winner.set(c.id, i);
    }
  });
  return checks.filter((c, i) => c.status === 'INFO' || winner.get(c.id) === i);
}

export class DPoPClientScenario implements Scenario {
  readonly name: string;
  readonly source = {
    extensionId: 'io.modelcontextprotocol/auth/dpop'
  } as const;
  readonly description: string;

  private authServer = new ServerLifecycle();
  private server = new ServerLifecycle();
  private checks: ConformanceCheck[] = [];
  private obs: DpopClientObservations = newDpopClientObservations();
  private tokenReqObs: DpopTokenRequestObservation = newTokenReqObs();

  /**
   * @param requireNonce when true (`auth/dpop-nonce`) the test AS and MCP server
   *   both demand a server-provided nonce (RFC 9449 §8/§9); when false
   *   (`auth/dpop`) neither challenges and the client completes with plain
   *   proofs — the common, nonce-less baseline.
   */
  constructor(private readonly requireNonce: boolean) {
    this.name = requireNonce ? 'auth/dpop-nonce' : 'auth/dpop';
    this.description = requireNonce
      ? 'Tests that an MCP client, when the authorization server and MCP server require a DPoP nonce, retries the token request and the MCP request with the server-supplied nonce (RFC 9449 §8/§9) — on top of requesting a DPoP-bound token and presenting it with the DPoP Authorization scheme and a fresh proof per request (SEP-1932 / RFC 9449 §5, §7.1, §4.2–4.3).'
      : 'Tests that an MCP client requests a DPoP-bound access token (a valid DPoP proof at the token request) and presents it using the DPoP Authorization scheme (not Bearer) with a fresh, well-formed DPoP proof on each POST /mcp request, when the server does not require a nonce (SEP-1932 / RFC 9449 §5, §7.1, §4.2–4.3).';
  }

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    this.obs = newDpopClientObservations();
    this.tokenReqObs = newTokenReqObs();

    const authApp = createAuthServer(ctx, this.checks, this.authServer.getUrl, {
      // Advertise exactly what the validators enforce, so a client honoring
      // RFC 9449 §5.1 alg negotiation is graded the same as one that doesn't.
      dpopSigningAlgValuesSupported: DPOP_ASYMMETRIC_ALGS,
      dpopTokenRequestObs: this.tokenReqObs,
      dpopRequireNonce: this.requireNonce
    });
    await this.authServer.start(authApp);

    const app = createServer(
      ctx,
      this.checks,
      this.server.getUrl,
      this.authServer.getUrl,
      {
        authMiddleware: createDpopResourceAuth(
          this.obs,
          () => `${this.server.getUrl()}/mcp`,
          () => `${this.server.getUrl()}${PRM_PATH}`,
          this.requireNonce
        )
      }
    );
    await this.server.start(app);

    return { serverUrl: `${this.server.getUrl()}/mcp` };
  }

  async stop(): Promise<void> {
    await this.authServer.stop();
    await this.server.stop();
  }

  getChecks(): ConformanceCheck[] {
    // Only the nonce posture re-POSTs /token (challenge → retry), which
    // duplicates the shared token-flow checks (token-request, pkce-*); collapse
    // those. The baseline (`auth/dpop`) is left untouched so genuinely distinct
    // repeated attempts (e.g. a restarted authorization flow) keep both entries.
    const shared = this.requireNonce
      ? collapseDuplicateChecks(this.checks)
      : this.checks;
    const checks: ConformanceCheck[] = [
      ...shared,
      this.tokenRequestProofCheck(),
      this.authSchemeCheck(),
      this.freshProofCheck()
    ];
    // The nonce checks only apply to the nonce-requiring posture: in the
    // baseline (`auth/dpop`) neither server issues a `use_dpop_nonce`
    // challenge, so there is no nonce behaviour to assert.
    if (this.requireNonce) {
      checks.push(this.asNonceCheck(), this.rsNonceCheck());
    }
    return checks;
  }

  private asNonceCheck(): ConformanceCheck {
    const challenged = this.tokenReqObs.asNonceChallengeIssued;
    const honored = this.tokenReqObs.asNonceHonored;
    // SUCCESS requires that a challenge was actually issued AND then honored —
    // grading `honored` alone would let a client that pre-sends the nonce
    // (never challenged) pass vacuously.
    const pass = challenged && honored;
    return this.build(
      'sep-1932-client-as-nonce',
      pass ? 'SUCCESS' : 'FAILURE',
      {
        errorMessage: pass
          ? undefined
          : challenged
            ? 'Client did not complete the token request with the server-supplied nonce after a use_dpop_nonce challenge (it either did not retry or the retried proof was rejected)'
            : 'Client never presented a valid proof that was answered with a use_dpop_nonce challenge',
        details: {
          challengeIssued: challenged,
          nonceHonored: honored
        }
      }
    );
  }

  private rsNonceCheck(): ConformanceCheck {
    const challenged = this.obs.rsNonceChallengeIssued;
    const honored = this.obs.rsNonceHonored;
    // SUCCESS requires that a challenge was actually issued AND then honored —
    // see asNonceCheck; grading `honored` alone permits a vacuous pass.
    const pass = challenged && honored;
    return this.build(
      'sep-1932-client-rs-nonce',
      pass ? 'SUCCESS' : 'FAILURE',
      {
        errorMessage: pass
          ? undefined
          : challenged
            ? 'Client did not complete the MCP request with the server-supplied nonce after a use_dpop_nonce challenge (it either did not retry or the retried proof was rejected)'
            : 'Client never made an MCP request with a valid proof that was answered with a use_dpop_nonce challenge',
        details: {
          challengeIssued: challenged,
          nonceHonored: honored
        }
      }
    );
  }

  private tokenRequestProofCheck(): ConformanceCheck {
    let status: CheckStatus;
    let errorMessage: string | undefined;
    if (!this.tokenReqObs.recorded) {
      status = 'FAILURE';
      errorMessage =
        'Client never completed an authorization_code token request, so it obtained no DPoP-bound token';
    } else if (!this.tokenReqObs.validProof) {
      status = 'FAILURE';
      errorMessage = `Client did not present a valid DPoP proof at the token endpoint: ${this.tokenReqObs.error}`;
    } else {
      status = 'SUCCESS';
    }
    return this.build('sep-1932-client-token-request-proof', status, {
      errorMessage,
      details: {
        tokenRequestObserved: this.tokenReqObs.recorded,
        validProofPresented: this.tokenReqObs.validProof
      }
    });
  }

  private authSchemeCheck(): ConformanceCheck {
    let status: CheckStatus;
    let errorMessage: string | undefined;
    if (this.obs.authenticatedRequests === 0) {
      status = 'FAILURE';
      errorMessage = 'Client never presented an access token to the MCP server';
    } else if (this.obs.nonDpopSchemeSeen) {
      status = 'FAILURE';
      errorMessage = `Client presented the token with a non-DPoP Authorization scheme (${[...new Set(this.obs.observedSchemes)].join(', ')})`;
    } else {
      status = 'SUCCESS';
    }
    return this.build('sep-1932-client-dpop-auth-scheme', status, {
      errorMessage,
      details: {
        authenticatedRequests: this.obs.authenticatedRequests,
        observedSchemes: [...new Set(this.obs.observedSchemes)]
      }
    });
  }

  private freshProofCheck(): ConformanceCheck {
    let status: CheckStatus;
    let errorMessage: string | undefined;
    if (this.obs.authenticatedRequests === 0) {
      status = 'FAILURE';
      errorMessage = 'Client never presented an access token to the MCP server';
    } else if (!this.obs.allProofsWellFormed) {
      status = 'FAILURE';
      // Attribute the failure to the right layer: a defect in the proof itself
      // vs. an access token the proof cannot be validated against.
      errorMessage = this.obs.proofError
        ? `DPoP proof was missing or malformed: ${this.obs.proofError}`
        : `DPoP proof could not be validated against the presented access token: ${this.obs.tokenError}`;
    } else if (this.obs.replayDetected) {
      status = 'FAILURE';
      errorMessage =
        'Client reused a DPoP proof (duplicate jti) across requests instead of sending a fresh one';
    } else {
      status = 'SUCCESS';
    }
    return this.build('sep-1932-client-fresh-proof', status, {
      errorMessage,
      details: {
        authenticatedRequests: this.obs.authenticatedRequests,
        distinctJtis: this.obs.jtisSeen.length,
        replayDetected: this.obs.replayDetected
      }
    });
  }

  private build(
    id: string,
    status: CheckStatus,
    opts: { errorMessage?: string; details?: Record<string, unknown> } = {}
  ): ConformanceCheck {
    const def = CHECK_DEFS[id];
    return {
      id,
      name: def.name,
      description: def.description,
      status,
      timestamp: new Date().toISOString(),
      specReferences: def.specReferences,
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      ...(opts.details ? { details: opts.details } : {})
    };
  }
}
