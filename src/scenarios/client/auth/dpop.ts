import type { ScenarioContext } from '../../../mock-server';
import type {
  Scenario,
  ConformanceCheck,
  CheckStatus,
  SpecReference
} from '../../../types';
import { ScenarioUrls, DRAFT_PROTOCOL_VERSION } from '../../../types';
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
      'Client includes a valid DPoP proof in the DPoP header of its token request, obtaining a DPoP-bound access token (RFC 9449 §5)',
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

export class DPoPClientScenario implements Scenario {
  readonly name: string;
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
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
      dpopSigningAlgValuesSupported: ['ES256'],
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
    const checks: ConformanceCheck[] = [
      ...this.checks,
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
    const honored = this.tokenReqObs.asNonceHonored;
    return this.build(
      'sep-1932-client-as-nonce',
      honored ? 'SUCCESS' : 'FAILURE',
      {
        errorMessage: honored
          ? undefined
          : this.tokenReqObs.asNonceChallengeIssued
            ? 'Client did not retry the token request with the server-supplied nonce after a use_dpop_nonce challenge'
            : 'Client never completed a token request that could be nonce-challenged',
        details: {
          challengeIssued: this.tokenReqObs.asNonceChallengeIssued,
          nonceHonored: honored
        }
      }
    );
  }

  private rsNonceCheck(): ConformanceCheck {
    const honored = this.obs.rsNonceHonored;
    return this.build(
      'sep-1932-client-rs-nonce',
      honored ? 'SUCCESS' : 'FAILURE',
      {
        errorMessage: honored
          ? undefined
          : this.obs.rsNonceChallengeIssued
            ? 'Client did not retry the MCP request with the server-supplied nonce after a use_dpop_nonce challenge'
            : 'Client never made an MCP request that could be nonce-challenged',
        details: {
          challengeIssued: this.obs.rsNonceChallengeIssued,
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
      errorMessage = `DPoP proof was missing or malformed: ${this.obs.proofError}`;
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
