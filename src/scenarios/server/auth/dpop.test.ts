import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'node:net';
import path from 'path';
import * as jose from 'jose';
import { testContext } from '../../../connection/testing';
import {
  DPoPServerValidationScenario,
  dpopChallengeError,
  protectedResourceMetadataFallbacks
} from './dpop';
import type { ConformanceCheck } from '../../../types';

const WINDOWS = process.platform === 'win32';

/** Find an unused TCP port (small TOCTOU window, fine for tests). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function freePorts(n: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < n) ports.add(await freePort());
  return [...ports];
}

/** Kill the whole process group so the `tsx`/`node` child isn't orphaned. */
function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!WINDOWS && proc.pid !== undefined) {
    process.kill(-proc.pid, signal); // negative pid → the detached group
  } else {
    proc.kill(signal);
  }
}

function startServer(
  script: string,
  port: number,
  extraEnv: Record<string, string>
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', script], {
      env: { ...process.env, PORT: port.toString(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !WINDOWS, // own process group → killable as a unit
      shell: WINDOWS
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      killTree(proc, 'SIGKILL');
      reject(
        new Error(`Server ${script} failed to start within 30s: ${stderr}`)
      );
    }, 30000);
    proc.stdout?.on('data', (data) => {
      if (data.toString().includes('running on')) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function stopServer(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.pid === undefined) return resolve();
    const t = setTimeout(() => {
      try {
        killTree(proc, 'SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      killTree(proc, 'SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

const COMPLIANT = path.join(
  process.cwd(),
  'examples/servers/typescript/sep-1932-compliant-server.ts'
);
const BROKEN = path.join(
  process.cwd(),
  'examples/servers/typescript/sep-1932-broken-server.ts'
);
const REJECT_ALL = path.join(
  process.cwd(),
  'examples/servers/typescript/sep-1932-reject-all-server.ts'
);
const ISSUER = 'https://conformance-dpop-issuer.example.com';
const url = (p: number) => `http://localhost:${p}/mcp`;

function byId(checks: ConformanceCheck[], id: string): ConformanceCheck[] {
  return checks.filter((c) => c.id === id);
}

describe('protectedResourceMetadataFallbacks', () => {
  it('tries the path-based well-known URL before the root one', () => {
    expect(
      protectedResourceMetadataFallbacks('http://localhost:9/mcp')
    ).toEqual({
      pathBased: 'http://localhost:9/.well-known/oauth-protected-resource/mcp',
      root: 'http://localhost:9/.well-known/oauth-protected-resource'
    });
    expect(
      protectedResourceMetadataFallbacks('http://localhost:9/public/mcp')
    ).toEqual({
      pathBased:
        'http://localhost:9/.well-known/oauth-protected-resource/public/mcp',
      root: 'http://localhost:9/.well-known/oauth-protected-resource'
    });
    expect(protectedResourceMetadataFallbacks('http://localhost:9')).toEqual({
      pathBased: 'http://localhost:9/.well-known/oauth-protected-resource',
      root: 'http://localhost:9/.well-known/oauth-protected-resource'
    });
  });
});

describe('dpopChallengeError', () => {
  it('reads a quoted or unquoted error from the DPoP challenge', () => {
    expect(
      dpopChallengeError(
        'DPoP error="invalid_dpop_proof", error_description="bad proof"'
      )
    ).toBe('invalid_dpop_proof');
    expect(dpopChallengeError('DPoP error=invalid_token')).toBe(
      'invalid_token'
    );
    expect(dpopChallengeError('dpop error="invalid_dpop_proof"')).toBe(
      'invalid_dpop_proof'
    );
  });

  it('ignores the error param of a sibling challenge', () => {
    expect(
      dpopChallengeError(
        'Bearer error="invalid_token", error_description="nope", DPoP error="invalid_dpop_proof", algs="ES256"'
      )
    ).toBe('invalid_dpop_proof');
    expect(
      dpopChallengeError(
        'DPoP error="invalid_dpop_proof", error_description="a, b", Bearer error="invalid_token"'
      )
    ).toBe('invalid_dpop_proof');
    expect(
      dpopChallengeError('Bearer error="invalid_token", DPoP algs="ES256"')
    ).toBeUndefined();
  });
});

function genuineFailures(checks: ConformanceCheck[]): string[] {
  return checks
    .filter((c) => c.status === 'FAILURE' && !c.details?.untestable)
    .map((c) => `${c.id}/${c.name}: ${c.errorMessage}`);
}

describe('DPoP server validation scenario', () => {
  let procs: ChildProcess[] = [];
  let ports: Record<string, number> = {};
  let savedEnv: { jwk?: string; issuer?: string };

  beforeAll(async () => {
    // One issuer key, shared: the scenario mints with the private key (via env),
    // the example servers trust the matching public key (via env).
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', {
      extractable: true
    });
    const publicJwk = { ...(await jose.exportJWK(publicKey)), alg: 'ES256' };
    const privateJwk = { ...(await jose.exportJWK(privateKey)), alg: 'ES256' };

    savedEnv = {
      jwk: process.env.DPOP_ISSUER_PRIVATE_JWK,
      issuer: process.env.DPOP_ISSUER
    };
    process.env.DPOP_ISSUER_PRIVATE_JWK = JSON.stringify(privateJwk);
    process.env.DPOP_ISSUER = ISSUER;

    const issuerEnv = (port: number, extra: Record<string, string> = {}) => ({
      DPOP_ISSUER_JWK: JSON.stringify(publicJwk),
      DPOP_ISSUER: ISSUER,
      DPOP_AUDIENCE: url(port),
      ...extra
    });

    const fixtures: Array<{
      name: string;
      script: string;
      env: Record<string, string>;
    }> = [
      { name: 'compliant', script: COMPLIANT, env: {} },
      { name: 'broken', script: BROKEN, env: {} },
      { name: 'rejectAll', script: REJECT_ALL, env: {} },
      { name: 'strict', script: COMPLIANT, env: { DPOP_REQUIRE_NONCE: '1' } },
      {
        name: 'buggy',
        script: COMPLIANT,
        env: { DPOP_REQUIRE_NONCE: '1', DPOP_NONCE_ACCEPT_ANY: '1' }
      },
      {
        name: 'nonceFirst',
        script: COMPLIANT,
        env: { DPOP_REQUIRE_NONCE: '1', DPOP_NONCE_FIRST: '1' }
      },
      {
        name: 'clockSkew',
        script: COMPLIANT,
        env: { DPOP_CLOCK_OFFSET_SECONDS: '-30' }
      },
      {
        name: 'bearerReject',
        script: COMPLIANT,
        env: { DPOP_BEARER_REJECT_STATUS: '500' }
      },
      {
        name: 'errorOverride',
        script: COMPLIANT,
        env: { DPOP_ERROR_CODE_OVERRIDE: 'invalid_request' }
      },
      {
        name: 'omitAlgsField',
        script: COMPLIANT,
        env: { DPOP_PRM_OMIT_ALGS: '1' }
      },
      {
        name: 'omitRequired',
        script: COMPLIANT,
        env: { DPOP_PRM_OMIT_REQUIRED: '1' }
      },
      {
        name: 'optionalDpop',
        script: COMPLIANT,
        env: {
          DPOP_PRM_OMIT_REQUIRED: '1',
          DPOP_ACCEPT_UNBOUND_BEARER: '1'
        }
      },
      {
        name: 'acceptUnbound',
        script: COMPLIANT,
        env: { DPOP_ACCEPT_UNBOUND_BEARER: '1' }
      },
      {
        name: 'prmNone',
        script: COMPLIANT,
        env: { DPOP_PRM_INCLUDE_NONE: '1' }
      },
      {
        name: 'omitAlgs',
        script: COMPLIANT,
        env: { DPOP_OMIT_CHALLENGE_ALGS: '1' }
      },
      {
        name: 'prmDisabled',
        script: COMPLIANT,
        env: { DPOP_PRM_DISABLED: '1' }
      },
      {
        name: 'wrongResource',
        script: COMPLIANT,
        env: { DPOP_PRM_WRONG_RESOURCE: '1' }
      },
      {
        name: 'bearerOnly',
        script: COMPLIANT,
        env: { DPOP_BEARER_ONLY_CHALLENGE: '1' }
      },
      {
        name: 'bearerOnlyOptional',
        script: COMPLIANT,
        env: {
          DPOP_BEARER_ONLY_CHALLENGE: '1',
          DPOP_PRM_OMIT_REQUIRED: '1',
          DPOP_ACCEPT_UNBOUND_BEARER: '1'
        }
      },
      {
        name: 'emptyAlgs',
        script: COMPLIANT,
        env: { DPOP_PRM_EMPTY_ALGS: '1' }
      },
      {
        name: 'algsNotArray',
        script: COMPLIANT,
        env: { DPOP_PRM_ALGS_NOT_ARRAY: '1' }
      },
      {
        name: 'algNonString',
        script: COMPLIANT,
        env: { DPOP_PRM_ALG_NON_STRING: '1' }
      },
      {
        name: 'requiredNotBoolean',
        script: COMPLIANT,
        env: {
          DPOP_PRM_REQUIRED_NOT_BOOLEAN: '1',
          DPOP_ACCEPT_UNBOUND_BEARER: '1'
        }
      },
      {
        name: 'prmHs256',
        script: COMPLIANT,
        env: { DPOP_PRM_INCLUDE_HS256: '1' }
      },
      {
        name: 'unbound403',
        script: COMPLIANT,
        env: { DPOP_UNBOUND_REJECT_STATUS: '403' }
      },
      {
        name: 'unbound400',
        script: COMPLIANT,
        env: { DPOP_UNBOUND_REJECT_STATUS: '400' }
      },
      {
        name: 'prmRoot',
        script: COMPLIANT,
        env: { DPOP_PRM_AT_ROOT: '1', DPOP_OMIT_RESOURCE_METADATA: '1' }
      },
      {
        name: 'prmRootWrongResource',
        script: COMPLIANT,
        env: {
          DPOP_PRM_AT_ROOT: '1',
          DPOP_OMIT_RESOURCE_METADATA: '1',
          DPOP_PRM_WRONG_RESOURCE: '1'
        }
      },
      {
        name: 'unbound500',
        script: COMPLIANT,
        env: { DPOP_UNBOUND_REJECT_STATUS: '500' }
      },
      {
        name: 'unboundNonce',
        script: COMPLIANT,
        env: {
          DPOP_UNBOUND_NONCE_CHALLENGE: '1',
          DPOP_PRM_OMIT_REQUIRED: '1'
        }
      },
      {
        name: 'omitResource',
        script: COMPLIANT,
        env: { DPOP_PRM_OMIT_RESOURCE: '1' }
      },
      {
        name: 'wellKnown',
        script: COMPLIANT,
        env: { DPOP_OMIT_RESOURCE_METADATA: '1' }
      },
      {
        name: 'prmRedirect',
        script: COMPLIANT,
        env: { DPOP_PRM_REDIRECT: '1' }
      },
      { name: 'prmHtml', script: COMPLIANT, env: { DPOP_PRM_HTML: '1' } }
    ];

    const allocated = await freePorts(fixtures.length);
    ports = Object.fromEntries(
      fixtures.map((fixture, i) => [fixture.name, allocated[i]])
    );
    procs = await Promise.all(
      fixtures.map((fixture, i) => {
        const port = allocated[i];
        const env =
          fixture.script === COMPLIANT
            ? issuerEnv(port, fixture.env)
            : fixture.env;
        return startServer(fixture.script, port, env);
      })
    );
  }, 180000);

  afterAll(async () => {
    await Promise.all(procs.map((proc) => stopServer(proc)));
    process.env.DPOP_ISSUER_PRIVATE_JWK = savedEnv.jwk;
    process.env.DPOP_ISSUER = savedEnv.issuer;
    if (savedEnv.jwk === undefined) delete process.env.DPOP_ISSUER_PRIVATE_JWK;
    if (savedEnv.issuer === undefined) delete process.env.DPOP_ISSUER;
  });

  it('passes every check against a compliant server (no FAILUREs)', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.compliant))
    );

    const failures = checks.filter((c) => c.status === 'FAILURE');
    expect(failures.map((c) => `${c.id}/${c.name}: ${c.errorMessage}`)).toEqual(
      []
    );

    expect(
      byId(checks, 'sep-1932-server-validate-proof').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
    expect(
      byId(checks, 'sep-1932-server-validate-proof').find(
        (c) => c.name === 'RejectsBearerScheme'
      )?.status
    ).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-error-code')[0].status).toBe(
      'SUCCESS'
    );
    expect(byId(checks, 'sep-1932-server-advertises-dpop')[0].status).toBe(
      'SUCCESS'
    );
    expect(byId(checks, 'sep-1932-server-prm-dpop')[0].status).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(
      byId(checks, 'sep-1932-server-iat-window').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
    expect(
      byId(checks, 'sep-1932-asymmetric-alg-only').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
    expect(
      byId(checks, 'sep-1932-server-audience-validation').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
    expect(
      byId(checks, 'sep-1932-server-reject-401').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
    // Compliant server does not require a nonce → nonce flow is optional/SKIPPED.
    expect(byId(checks, 'sep-1932-server-nonce')[0].status).toBe('SKIPPED');
  }, 30000);

  it('emits FAILURE against a server that does not validate DPoP', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.broken))
    );

    const rejects = byId(checks, 'sep-1932-server-validate-proof').filter((c) =>
      c.name.startsWith('Rejects')
    );
    expect(rejects.length).toBeGreaterThan(0);
    expect(rejects.every((c) => c.status === 'FAILURE')).toBe(true);

    expect(byId(checks, 'sep-1932-server-reject-401')[0].status).toBe(
      'FAILURE'
    );
    expect(
      byId(checks, 'sep-1932-server-iat-window').every(
        (c) => c.status === 'FAILURE'
      )
    ).toBe(true);
    expect(
      byId(checks, 'sep-1932-asymmetric-alg-only').every(
        (c) => c.status === 'FAILURE'
      )
    ).toBe(true);
    expect(byId(checks, 'sep-1932-server-audience-validation')[0].status).toBe(
      'FAILURE'
    );

    // Not a 401, so the challenge sentences are not exercised. The unconditional
    // obligation is a SHOULD, so the untestable result is a WARNING.
    const advertises = byId(checks, 'sep-1932-server-advertises-dpop')[0];
    expect(advertises.status).toBe('WARNING');
    expect(advertises.details?.untestable).toBe(true);
    // Nothing serves protected resource metadata, and consistency must not
    // invent a document in order to accuse the server.
    expect(
      byId(checks, 'sep-1932-server-prm-dpop')[0].details?.untestable
    ).toBe(true);
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.details?.untestable).toBe(true);
    expect(consistency.errorMessage).toContain(
      'cannot evaluate advertisement consistency'
    );
  }, 30000);

  it('reports rejection checks notTestable (not vacuous SUCCESS) against a reject-everything server', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.rejectAll))
    );

    // The valid baseline is refused → the positive check fails.
    const positive = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'AcceptsValidProof'
    );
    expect(positive?.status).toBe('FAILURE');

    // Every rejection check must be gated to notTestable (#248), never SUCCESS:
    // a 401 here cannot be attributed to validation when the server 401s
    // everything — otherwise a reject-all server would pass the whole battery.
    const gated = [
      ...byId(checks, 'sep-1932-server-validate-proof').filter((c) =>
        c.name.startsWith('Rejects')
      ),
      ...byId(checks, 'sep-1932-server-iat-window'),
      ...byId(checks, 'sep-1932-asymmetric-alg-only'),
      ...byId(checks, 'sep-1932-server-audience-validation'),
      ...byId(checks, 'sep-1932-server-reject-401')
    ];

    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((c) => c.details?.untestable === true)).toBe(true);
    expect(gated.some((c) => c.status === 'SUCCESS')).toBe(false);

    // Discovery is not gated on the positive probe: this server still 401s
    // with a DPoP challenge and algs. Consistency is gated, because a 401
    // here cannot be attributed to the unbound token.
    expect(byId(checks, 'sep-1932-server-advertises-dpop')[0].status).toBe(
      'SUCCESS'
    );
    expect(
      byId(checks, 'sep-1932-server-prm-consistency')[0].details?.untestable
    ).toBe(true);
  }, 30000);

  // The baseline completes the nonce handshake (acceptValid retries with the
  // server-issued nonce), so it passes against a nonce-requiring server. A
  // server that requires a nonce but checks it AFTER structural validation
  // still rejects the malformed negatives on their real defect, so those checks
  // stay meaningful; the nonce-FIRST case below covers the adversary that gates
  // on the nonce before anything else.
  it('reports the nonce check SUCCESS against a correct nonce server', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.strict))
    );
    expect(byId(checks, 'sep-1932-server-nonce')[0].status).toBe('SUCCESS');
  }, 30000);

  it('correctly tests a nonce-first server by retrying negatives with the nonce', async () => {
    // Without the retry, a server that gates on the nonce before any structural
    // check would answer every nonce-less negative with use_dpop_nonce → each
    // check would go not-testable → a red run for a *conformant* server. The
    // scenario instead folds the handshake nonce into the negatives, so the
    // server rejects each on its real defect (SUCCESS). Only malformed-not-a-jwt,
    // which can't carry a nonce, stays not-testable.
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.nonceFirst))
    );

    // Baseline succeeds via the nonce handshake.
    expect(
      byId(checks, 'sep-1932-server-validate-proof').find(
        (c) => c.name === 'AcceptsValidProof'
      )?.status
    ).toBe('SUCCESS');

    const rejections = [
      ...byId(checks, 'sep-1932-server-validate-proof').filter((c) =>
        c.name.startsWith('Rejects')
      ),
      ...byId(checks, 'sep-1932-server-iat-window'),
      ...byId(checks, 'sep-1932-asymmetric-alg-only'),
      ...byId(checks, 'sep-1932-server-audience-validation'),
      ...byId(checks, 'sep-1932-server-reject-401')
    ];
    // No spurious FAILURE against a conformant server, and the negatives are
    // genuinely exercised (SUCCESS) rather than all going not-testable.
    // No *genuine* FAILURE against a conformant server (untestable checks carry
    // FAILURE status but are flagged details.untestable — handled separately).
    expect(
      rejections
        .filter((c) => c.status === 'FAILURE' && !c.details?.untestable)
        .map((c) => `${c.name}: ${c.errorMessage}`)
    ).toEqual([]);
    // Every retryable negative is genuinely exercised (SUCCESS); exactly one —
    // the malformed proof that can't carry a nonce — remains untestable.
    expect(rejections.filter((c) => c.status === 'SUCCESS').length).toBe(
      rejections.length - 1
    );
    const malformed = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'RejectsMalformedProof'
    );
    expect(malformed?.details?.untestable).toBe(true);
  }, 30000);

  it('reports the nonce check WARNING against a server that accepts any nonce', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.buggy))
    );
    expect(byId(checks, 'sep-1932-server-nonce')[0].status).toBe('WARNING');
  }, 30000);

  it('reports FAILURE when a Bearer-scheme request is answered with a non-auth status and no challenge', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.bearerReject))
    );

    const bearer = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'RejectsBearerScheme'
    );
    expect(bearer?.status).toBe('FAILURE');

    // This fixture only mishandles Bearer-scheme presentation — every other
    // validate-proof probe still behaves as on the compliant server.
    const others = byId(checks, 'sep-1932-server-validate-proof').filter(
      (c) => c.name !== 'RejectsBearerScheme'
    );
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.status === 'SUCCESS')).toBe(true);
  }, 30000);

  it('reports WARNING when every rejection uses the wrong DPoP error code', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.errorOverride))
    );

    const errorCode = byId(checks, 'sep-1932-server-error-code')[0];
    expect(errorCode.status).toBe('WARNING');
    expect(errorCode.details?.untestable).toBeUndefined();
    const mismatches = errorCode.details?.mismatches as Array<{
      case: string;
      expected: string;
      actual: string | null;
    }>;
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.every((m) => m.actual === 'invalid_request')).toBe(true);

    // The override only changes the error param. MUST checks still see 401 +
    // a DPoP challenge.
    const failures = checks.filter(
      (c) => c.status === 'FAILURE' && !c.details?.untestable
    );
    expect(failures.map((c) => `${c.id}/${c.name}: ${c.errorMessage}`)).toEqual(
      []
    );
  }, 30000);

  it('reports FAILURE when protected resource metadata omits the algorithms field', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.omitAlgsField))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('FAILURE');
    expect(prm.errorMessage).toBe(
      'Protected resource metadata is missing dpop_signing_alg_values_supported'
    );
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop: Protected resource metadata is missing dpop_signing_alg_values_supported'
    ]);
  }, 30000);

  it('treats an absent dpop_bound_access_tokens_required as not required', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.omitRequired))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('SUCCESS');
    expect(prm.details?.dpop_bound_access_tokens_required).toBeNull();
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('FAILURE');
    expect(consistency.errorMessage).toBe(
      'server requires DPoP but does not advertise it'
    );
    expect(consistency.details?.dpop_bound_access_tokens_required).toBeNull();
    expect(consistency.details?.wwwAuthenticate).toEqual(expect.any(String));
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-consistency/PrmConsistency: server requires DPoP but does not advertise it'
    ]);
  }, 30000);

  it('passes when DPoP is supported but not required and bearer tokens are accepted', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.optionalDpop))
    );

    expect(byId(checks, 'sep-1932-server-prm-dpop')[0].status).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('does not grade DPoP fields or consistency when metadata is unreachable', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmDisabled))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.details?.untestable).toBe(true);
    expect(prm.errorMessage).toContain('not 200');
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.details?.untestable).toBe(true);
    expect(consistency.errorMessage).toContain(
      'cannot evaluate advertisement consistency'
    );
    expect(consistency.errorMessage).not.toContain('does not advertise');
    expect(byId(checks, 'sep-1932-server-advertises-dpop')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('does not grade protected resource metadata whose resource identifier does not match', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.wrongResource))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.details?.untestable).toBe(true);
    expect(prm.errorMessage).toContain('unusable (RFC 9728 §3.3)');
    expect(prm.errorMessage).toContain('https://attacker.example/mcp');
    expect(prm.errorMessage).toContain(url(ports.wrongResource));
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.details?.untestable).toBe(true);
    expect(consistency.errorMessage).toContain(
      'cannot evaluate advertisement consistency'
    );
    expect(consistency.errorMessage).toContain('unusable (RFC 9728 §3.3)');
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('fails a required-DPoP server whose 401 has no DPoP challenge', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.bearerOnly))
    );

    const advertises = byId(checks, 'sep-1932-server-advertises-dpop')[0];
    expect(advertises.status).toBe('FAILURE');
    expect(advertises.errorMessage).toBe(
      'Protected resource metadata sets dpop_bound_access_tokens_required to true, but the HTTP 401 did not include a DPoP challenge'
    );
    expect(byId(checks, 'sep-1932-server-prm-dpop')[0].status).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-advertises-dpop/AdvertisesDpop: Protected resource metadata sets dpop_bound_access_tokens_required to true, but the HTTP 401 did not include a DPoP challenge'
    ]);
  }, 30000);

  it('warns when an optional-DPoP server answers 401 with only a Bearer challenge', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.bearerOnlyOptional))
    );

    const advertises = byId(checks, 'sep-1932-server-advertises-dpop')[0];
    expect(advertises.status).toBe('WARNING');
    expect(advertises.errorMessage).toBe(
      'HTTP 401 did not include a DPoP challenge'
    );
    expect(byId(checks, 'sep-1932-server-prm-dpop')[0].status).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('reports an empty algorithms array separately from a missing field', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.emptyAlgs))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('FAILURE');
    expect(prm.errorMessage).toBe('dpop_signing_alg_values_supported is empty');
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop: dpop_signing_alg_values_supported is empty'
    ]);
  }, 30000);

  it('reports a non-array algorithms value as malformed', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.algsNotArray))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.errorMessage).toBe(
      'dpop_signing_alg_values_supported is malformed: expected a JSON array'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop: dpop_signing_alg_values_supported is malformed: expected a JSON array'
    ]);
  }, 30000);

  it('reports a non-string algorithms entry as malformed', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.algNonString))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.errorMessage).toBe(
      'dpop_signing_alg_values_supported is malformed: every entry must be a non-empty string'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop: dpop_signing_alg_values_supported is malformed: every entry must be a non-empty string'
    ]);
  }, 30000);

  it('reports a non-boolean dpop_bound_access_tokens_required as malformed', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.requiredNotBoolean))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.errorMessage).toBe(
      'dpop_bound_access_tokens_required is malformed: expected a boolean'
    );
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop: dpop_bound_access_tokens_required is malformed: expected a boolean'
    ]);
  }, 30000);

  it('reports FAILURE when protected resource metadata lists HS256', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmHs256))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('FAILURE');
    expect(prm.details?.forbidden).toEqual(['HS256']);
    expect(genuineFailures(checks).map((line) => line.split(':')[0])).toEqual([
      'sep-1932-server-prm-dpop/PrmDpop'
    ]);
  }, 30000);

  it('counts HTTP 403 as rejection when metadata says DPoP is required', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.unbound403))
    );
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('SUCCESS');
    expect(consistency.details?.statusCode).toBe(403);
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('counts HTTP 400 as rejection when metadata says DPoP is required', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.unbound400))
    );
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('SUCCESS');
    expect(consistency.details?.statusCode).toBe(400);
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('accepts the origin as resource for metadata at the root well-known URL', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmRoot))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('SUCCESS');
    expect(prm.details?.source).toBe('well-known-root');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('still rejects a different origin as resource at the root well-known URL', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmRootWrongResource))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.details?.untestable).toBe(true);
    expect(prm.errorMessage).toContain(
      `at http://localhost:${ports.prmRootWrongResource}/.well-known/oauth-protected-resource is unusable`
    );
    expect(prm.errorMessage).toContain('https://attacker.example/mcp');
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('does not count HTTP 500 as rejection of an unbound Bearer token', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.unbound500))
    );
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('FAILURE');
    expect(consistency.errorMessage).toBe(
      'The server did not reject an unbound Bearer token (HTTP 500)'
    );
    expect(genuineFailures(checks)).toEqual([
      'sep-1932-server-prm-consistency/PrmConsistency: The server did not reject an unbound Bearer token (HTTP 500)'
    ]);
  }, 30000);

  it('loads protected resource metadata from the well-known URL when the challenge omits resource_metadata', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.wellKnown))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('SUCCESS');
    expect(prm.details?.source).toBe('well-known-path');
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('follows a redirect to protected resource metadata', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmRedirect))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('SUCCESS');
    expect(prm.details?.source).toBe('resource_metadata');
    expect(prm.details?.url).toBe(
      `http://localhost:${ports.prmRedirect}/.well-known/oauth-protected-resource/mcp`
    );
    expect(prm.details?.redirectedFrom).toBe(
      `http://localhost:${ports.prmRedirect}/prm-redirect`
    );
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('does not infer unadvertised enforcement from a nonce challenge to an unbound Bearer token', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.unboundNonce))
    );
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.details?.untestable).toBe(true);
    expect(consistency.errorMessage).toContain('use_dpop_nonce');
    expect(consistency.errorMessage).not.toContain('does not advertise');
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('names a missing resource field instead of printing undefined', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.omitResource))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.details?.untestable).toBe(true);
    expect(prm.errorMessage).toContain(
      `the resource field is missing (expected ${url(ports.omitResource)})`
    );
    expect(prm.errorMessage).not.toContain('undefined');
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('does not grade a metadata response whose Content-Type is not application/json', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmHtml))
    );
    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.details?.untestable).toBe(true);
    expect(prm.errorMessage).toContain('Content-Type');
    expect(prm.errorMessage).toContain('text/html');
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.details?.untestable).toBe(true);
    expect(genuineFailures(checks)).toEqual([]);
  }, 30000);

  it('reports FAILURE when metadata requires DPoP but an unbound Bearer token is accepted', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.acceptUnbound))
    );

    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('FAILURE');
    expect(consistency.details?.untestable).toBeUndefined();

    const positive = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'AcceptsValidProof'
    );
    expect(positive?.status).toBe('SUCCESS');
    const bearer = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'RejectsBearerScheme'
    );
    expect(bearer?.status).toBe('SUCCESS');
  }, 30000);

  it('reports FAILURE when protected resource metadata lists the none algorithm', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmNone))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('FAILURE');
    expect(prm.details?.forbidden).toEqual(['none']);

    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
    const positive = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'AcceptsValidProof'
    );
    expect(positive?.status).toBe('SUCCESS');
  }, 30000);

  it('reports WARNING when the DPoP challenge omits algs', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.omitAlgs))
    );

    const advertises = byId(checks, 'sep-1932-server-advertises-dpop')[0];
    expect(advertises.status).toBe('WARNING');
    expect(advertises.errorMessage).toBe(
      'DPoP challenge is missing the algs parameter'
    );
    expect(byId(checks, 'sep-1932-server-prm-dpop')[0].status).toBe('SUCCESS');
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'SUCCESS'
    );
  }, 30000);

  it('anchors iat probes to the server clock (no false failure under skew)', async () => {
    // The server's clock is 30s behind the framework. Without anchoring, the
    // stale probe (now−303s by the framework clock) looks only ~273s old to the
    // server → inside ±5 min → wrongly accepted → the iat check would FAIL a
    // conformant server. Anchoring to the server's Date header keeps it rejected.
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.clockSkew))
    );
    expect(
      byId(checks, 'sep-1932-server-iat-window').every(
        (c) => c.status === 'SUCCESS'
      )
    ).toBe(true);
  }, 30000);
});
