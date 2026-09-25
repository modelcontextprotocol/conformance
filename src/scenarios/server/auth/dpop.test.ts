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

describe('DPoP server validation scenario', () => {
  let compliant: ChildProcess | null = null;
  let broken: ChildProcess | null = null;
  let rejectAll: ChildProcess | null = null;
  let nonceStrict: ChildProcess | null = null;
  let nonceBuggy: ChildProcess | null = null;
  let nonceFirst: ChildProcess | null = null;
  let clockSkew: ChildProcess | null = null;
  let bearerReject: ChildProcess | null = null;
  let errorOverride: ChildProcess | null = null;
  let prmOmit: ChildProcess | null = null;
  let acceptUnbound: ChildProcess | null = null;
  let prmNone: ChildProcess | null = null;
  let omitAlgs: ChildProcess | null = null;
  let ports: {
    compliant: number;
    broken: number;
    rejectAll: number;
    strict: number;
    buggy: number;
    nonceFirst: number;
    clockSkew: number;
    bearerReject: number;
    errorOverride: number;
    prmOmit: number;
    acceptUnbound: number;
    prmNone: number;
    omitAlgs: number;
  };
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

    const [cp, bp, rp, sp, gp, nf, ck, br, eo, po, au, pn, oa] =
      await freePorts(13);
    ports = {
      compliant: cp,
      broken: bp,
      rejectAll: rp,
      strict: sp,
      buggy: gp,
      nonceFirst: nf,
      clockSkew: ck,
      bearerReject: br,
      errorOverride: eo,
      prmOmit: po,
      acceptUnbound: au,
      prmNone: pn,
      omitAlgs: oa
    };

    const issuerEnv = (port: number, extra: Record<string, string> = {}) => ({
      DPOP_ISSUER_JWK: JSON.stringify(publicJwk),
      DPOP_ISSUER: ISSUER,
      DPOP_AUDIENCE: url(port),
      ...extra
    });

    [
      compliant,
      broken,
      rejectAll,
      nonceStrict,
      nonceBuggy,
      nonceFirst,
      clockSkew,
      bearerReject,
      errorOverride,
      prmOmit,
      acceptUnbound,
      prmNone,
      omitAlgs
    ] = await Promise.all([
      startServer(COMPLIANT, cp, issuerEnv(cp)),
      startServer(BROKEN, bp, {}),
      startServer(REJECT_ALL, rp, {}),
      startServer(COMPLIANT, sp, issuerEnv(sp, { DPOP_REQUIRE_NONCE: '1' })),
      startServer(
        COMPLIANT,
        gp,
        issuerEnv(gp, { DPOP_REQUIRE_NONCE: '1', DPOP_NONCE_ACCEPT_ANY: '1' })
      ),
      startServer(
        COMPLIANT,
        nf,
        issuerEnv(nf, { DPOP_REQUIRE_NONCE: '1', DPOP_NONCE_FIRST: '1' })
      ),
      startServer(
        COMPLIANT,
        ck,
        issuerEnv(ck, { DPOP_CLOCK_OFFSET_SECONDS: '-30' })
      ),
      startServer(
        COMPLIANT,
        br,
        issuerEnv(br, { DPOP_BEARER_REJECT_STATUS: '500' })
      ),
      startServer(
        COMPLIANT,
        eo,
        issuerEnv(eo, { DPOP_ERROR_CODE_OVERRIDE: 'invalid_request' })
      ),
      startServer(COMPLIANT, po, issuerEnv(po, { DPOP_PRM_OMIT_FIELDS: '1' })),
      startServer(
        COMPLIANT,
        au,
        issuerEnv(au, { DPOP_ACCEPT_UNBOUND_BEARER: '1' })
      ),
      startServer(COMPLIANT, pn, issuerEnv(pn, { DPOP_PRM_INCLUDE_NONE: '1' })),
      startServer(
        COMPLIANT,
        oa,
        issuerEnv(oa, { DPOP_OMIT_CHALLENGE_ALGS: '1' })
      )
    ]);
  }, 120000);

  afterAll(async () => {
    await Promise.all([
      stopServer(compliant),
      stopServer(broken),
      stopServer(rejectAll),
      stopServer(nonceStrict),
      stopServer(nonceBuggy),
      stopServer(nonceFirst),
      stopServer(clockSkew),
      stopServer(bearerReject),
      stopServer(errorOverride),
      stopServer(prmOmit),
      stopServer(acceptUnbound),
      stopServer(prmNone),
      stopServer(omitAlgs)
    ]);
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

    // No DPoP challenge at all.
    expect(byId(checks, 'sep-1932-server-advertises-dpop')[0].status).toBe(
      'FAILURE'
    );
    // Nothing serves protected resource metadata.
    expect(
      byId(checks, 'sep-1932-server-prm-dpop')[0].details?.untestable
    ).toBe(true);
    // Silent metadata and an accepted unbound Bearer token are consistent.
    expect(byId(checks, 'sep-1932-server-prm-consistency')[0].status).toBe(
      'INFO'
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

  it('reports FAILURE when protected resource metadata omits both DPoP fields', async () => {
    const checks = await new DPoPServerValidationScenario().run(
      testContext(url(ports.prmOmit))
    );

    const prm = byId(checks, 'sep-1932-server-prm-dpop')[0];
    expect(prm.status).toBe('FAILURE');
    expect(prm.details?.untestable).toBeUndefined();
    const consistency = byId(checks, 'sep-1932-server-prm-consistency')[0];
    expect(consistency.status).toBe('FAILURE');
    expect(consistency.errorMessage).toBe(
      'server requires DPoP but does not advertise it'
    );

    const positive = byId(checks, 'sep-1932-server-validate-proof').find(
      (c) => c.name === 'AcceptsValidProof'
    );
    expect(positive?.status).toBe('SUCCESS');
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
