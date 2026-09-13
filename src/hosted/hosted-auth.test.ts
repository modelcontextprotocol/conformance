/**
 * Hosted auth scenarios — RS app + a local relay simulating the AS origin.
 *
 * Mirrors the production topology (RS val.town app + AS relay val) on two
 * ephemeral localhost ports, then walks the OAuth discovery → DCR →
 * authorize → token → MCP flow by hand to prove the path-rewrite and
 * relay-secret guard work end to end.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createHostedApp } from './server';
import { SessionManager, rawChecksOf, finalizeChecks } from './session';
import { buildMatrix, startability } from './matrix';
import { MemoryRunStore } from './store';
import { getScenario } from '../scenarios';
import type { AuxOriginRole, ConformanceCheck, SpecVersion } from '../types';
import { toFetchHandler } from '../../examples/hosted/fetch-bridge';
import { listenFetch, listenRelay } from '../../examples/hosted/local-relay';
import { runClient as noRetryLimitClient } from '../../examples/clients/typescript/auth-test-no-retry-limit';

const RELAY_SECRET = 'test-relay-secret-do-not-use-in-prod';

describe('hosted auth scenarios (RS + AS relay)', () => {
  let rsSrv: Server;
  let relaySrv: Server;
  let sessions: SessionManager;
  let rs: string; // RS origin
  let asOrigin: string; // relay origin

  beforeAll(async () => {
    // Relay first so we know its origin before configuring the RS app.
    const relay = express();
    relay.use(express.raw({ type: '*/*' }));
    relay.all(/.*/, async (req, res) => {
      const headers: Record<string, string> = {
        'x-relay-secret': RELAY_SECRET,
        'x-relay-host': req.headers.host ?? ''
      };
      for (const h of ['accept', 'authorization', 'content-type']) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const search = req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : '';
      const body = ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : new Uint8Array(req.body as Buffer);
      const upstream = await fetch(`${rs}/__aux/as${req.path}${search}`, {
        method: req.method,
        headers,
        body,
        redirect: 'manual'
      });
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => res.setHeader(k, v));
      res.send(Buffer.from(await upstream.arrayBuffer()));
    });
    asOrigin = await listen(relay, (s) => (relaySrv = s));

    const hosted = createHostedApp({
      auxOrigins: { as: asOrigin },
      relaySecret: RELAY_SECRET
    });
    sessions = hosted.sessions;
    rs = await listen(hosted.app, (s) => (rsSrv = s));
  });

  afterAll(async () => {
    await sessions.close();
    await Promise.all(
      [rsSrv, relaySrv].map((s) => new Promise<void>((r) => s.close(() => r())))
    );
  });

  it('makes auth/* cells startable when as-origin is configured', () => {
    const matrix = buildMatrix({ auxOrigins: { as: asOrigin } });
    for (const name of [
      'auth/basic-cimd',
      'auth/metadata-default',
      'auth/pre-registration'
    ]) {
      expect(matrix.cell(name, '2025-11-25')!.startable).toBe(true);
    }
    // A scenario that needs another aux origin waits for its relay.
    expect(
      matrix.cell('auth/authorization-server-migration', '2026-07-28')
    ).toMatchObject({
      startable: false,
      startReason: 'needs relay origin(s) [as2]'
    });
    expect(
      buildMatrix({ auxOrigins: { as: asOrigin, as2: asOrigin } }).cell(
        'auth/authorization-server-migration',
        '2026-07-28'
      )!.startable
    ).toBe(true);
    // Scenarios without authHandlers() stay unstartable regardless.
    expect(
      startability(getScenario('auth/dpop')!, { auxOrigins: { as: asOrigin } })
    ).toEqual({ startable: false, reason: 'not converted for hosting yet' });
  });

  it('rejects /__aux/* without the relay secret', async () => {
    const res = await fetch(
      `${rs}/__aux/as/.well-known/oauth-authorization-server/r/nope`
    );
    expect(res.status).toBe(403);
  });

  it('locates the /r/<run-id>/<rev>/<scenario> segments in an /__aux path', async () => {
    const hdr = { headers: { 'x-relay-secret': RELAY_SECRET } };
    const missing = /missing \/r\/<run-id>\/<revision>\/<scenario>/;
    // Illegal run id.
    let res = await fetch(
      `${rs}/__aux/as/tenant/r/bad!id/2025-11-25/auth/basic-cimd/token`,
      hdr
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(missing);
    // Unknown revision, unknown scenario.
    res = await fetch(
      `${rs}/__aux/as/r/run/2024-01-01/auth/basic-cimd/token`,
      hdr
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(missing);
    res = await fetch(`${rs}/__aux/as/r/run/2025-11-25/no-such/token`, hdr);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(missing);
    // A cell that does not apply to the revision is never mounted.
    res = await fetch(`${rs}/__aux/as/r/run/2026-07-28/initialize/token`, hdr);
    expect(res.status).toBe(404);
    expect((await res.json()).scoring).toBe('n/a');
    // Adversarial input that would make a regex backtrack.
    const evil = '/r/-'.repeat(2000) + '/r/x/token';
    res = await fetch(`${rs}/__aux/as${evil}`, hdr);
    expect(res.status).toBe(404);
  });

  it('rebuilds a cell from its id when the aux origin is hit first', async () => {
    // A client given the whole-run config may fetch AS metadata before it
    // ever touches the RS; on a multi-process host that request can land on
    // a process that never saw the run. The cell id carries everything.
    const cell = 'cold/2026-07-28/auth/metadata-default';
    const meta = await fetch(
      `${asOrigin}/.well-known/oauth-authorization-server/r/${cell}`
    ).then((r) => r.json());
    expect(meta.issuer).toBe(`${asOrigin}/r/${cell}`);
    expect(sessions.get(cell)?.revision).toBe('2026-07-28');
  });

  it('walks auth/metadata-default end-to-end through the relay', async () => {
    const cell = 'authflow/2025-11-25/auth/metadata-default';
    const mcpUrl = `${rs}/s/${cell}/mcp`;

    // 1. Unauthenticated MCP → 401 with WWW-Authenticate pointing at PRM
    const r401 = await fetch(mcpUrl, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(initBody())
    });
    expect(r401.status).toBe(401);
    const www = r401.headers.get('www-authenticate') ?? '';
    expect(www).toContain('resource_metadata=');

    // 2. PRM via root well-known dispatch (RFC 9728 path-suffix derivation)
    const prmUrl = `${rs}/.well-known/oauth-protected-resource/s/${cell}/mcp`;
    const prm = await fetch(prmUrl).then((r) => r.json());
    expect(prm.resource).toBe(mcpUrl);
    expect(prm.authorization_servers).toEqual([`${asOrigin}/r/${cell}`]);

    // 3. AS metadata — client derives well-known from issuer per RFC 8414 →
    //    hits the relay origin → forwarded to /__aux/as/… → run resolved.
    const asMeta = await fetch(
      `${asOrigin}/.well-known/oauth-authorization-server/r/${cell}`
    ).then((r) => r.json());
    expect(asMeta.issuer).toBe(`${asOrigin}/r/${cell}`);
    expect(asMeta.authorization_endpoint).toBe(
      `${asOrigin}/r/${cell}/authorize`
    );
    expect(asMeta.token_endpoint).toBe(`${asOrigin}/r/${cell}/token`);

    // 4. DCR
    const reg = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'vitest',
        redirect_uris: ['http://localhost:0/cb']
      })
    }).then((r) => r.json());
    expect(reg.client_id).toBeTruthy();

    // 5. /authorize → 302 to redirect_uri with code (relay passes redirect through)
    const authz = await fetch(
      `${asMeta.authorization_endpoint}?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'http://localhost:0/cb',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          resource: mcpUrl
        }),
      { redirect: 'manual' }
    );
    expect(authz.status).toBe(302);
    const loc = new URL(authz.headers.get('location')!);
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    // RFC 9207 iss parameter should be the per-cell issuer
    expect(loc.searchParams.get('iss')).toBe(`${asOrigin}/r/${cell}`);

    // 6. /token
    const tok = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'http://localhost:0/cb',
        client_id: reg.client_id,
        code_verifier:
          'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' /* matches challenge */,
        resource: mcpUrl
      })
    }).then((r) => r.json());
    expect(tok.access_token).toBeTruthy();

    // 7. Authenticated MCP initialize → 200
    const ok = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        authorization: `Bearer ${tok.access_token}`
      },
      body: JSON.stringify(initBody())
    });
    expect(ok.status).toBe(200);

    // Snapshot the raw log as a write-through store would persist it: no
    // end-of-run verdicts yet (step 9 below re-judges this copy).
    const raw = rawChecksOf(sessions.get(cell)!.scenario).map((c) => ({
      ...c
    }));
    expect(raw.some((c) => c.id.startsWith('resource-parameter-'))).toBe(false);

    // 8. Results — checks from BOTH origins accumulated on the one run.
    const results = await fetch(`${rs}/results/${cell}`).then((r) => r.json());
    const ids = results.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain('prm-pathbased-requested'); // RS-side
    expect(ids).toContain('authorization-server-metadata'); // AS-side via relay
    expect(ids).toContain('client-registration');
    expect(ids).toContain('authorization-request');
    expect(ids).toContain('token-request');
    const statusOf = (id: string) =>
      results.checks.find((c: { id: string }) => c.id === id)?.status;
    expect(statusOf('resource-parameter-in-authorization')).toBe('SUCCESS');
    expect(statusOf('resource-parameter-in-token')).toBe('SUCCESS');
    expect(statusOf('resource-parameter-matches-prm')).toBe('SUCCESS');

    // 9. Multi-isolate: on serverless hosts the isolate serving GET /results
    // is usually not the one that saw the OAuth flow. It re-judges the
    // persisted raw log in a fresh scenario instance, which never observed
    // the authorize/token requests directly — the RFC 8707 verdicts must be
    // recoverable from the log itself. (`raw` was snapshotted before step 8,
    // since getChecks() on the observing instance appends its verdicts.)
    const rejudged = finalizeChecks('auth/metadata-default', raw);
    const rejudgedStatus = (id: string) =>
      rejudged.find((c) => c.id === id)?.status;
    expect(rejudgedStatus('resource-parameter-in-authorization')).toBe(
      'SUCCESS'
    );
    expect(rejudgedStatus('resource-parameter-in-token')).toBe('SUCCESS');
    expect(rejudgedStatus('resource-parameter-consistency')).toBe('SUCCESS');
    expect(rejudgedStatus('resource-parameter-matches-prm')).toBe('SUCCESS');
    expect(rejudged.filter((c) => c.status === 'FAILURE')).toEqual([]);
  });

  it('exposes scenarioContext in the cell config env (pre-registration)', async () => {
    const cell = 'pre/2025-11-25/auth/pre-registration';
    const config = await fetch(`${rs}/s/${cell}?format=json`).then((r) =>
      r.json()
    );
    expect(config.cells).toHaveLength(1);
    expect(config.cells[0].url).toBe(`${rs}/s/${cell}/mcp`);
    expect(JSON.parse(config.cells[0].env.MCP_CONFORMANCE_CONTEXT)).toEqual({
      name: 'auth/pre-registration',
      client_id: 'pre-registered-client',
      client_secret: 'pre-registered-secret',
      // The AS issuer this cell publishes: the relay origin + /r/<cell-id>.
      issuer: `${asOrigin}/r/${cell}`
    });
  });

  it('routes tenant-prefixed AS metadata (auth/metadata-var2) correctly', async () => {
    const cell = 'tenant/2025-11-25/auth/metadata-var2';
    // Touch RS to lazily create the cell so the aux handler exists.
    await fetch(`${rs}/s/${cell}/mcp`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(initBody())
    });
    // Issuer is <as>/r/<cell>/tenant1 → well-known at
    // <as>/.well-known/oauth-authorization-server/r/<cell>/tenant1; the
    // scenario name is resolved by longest match, so `tenant1` is a suffix.
    const meta = await fetch(
      `${asOrigin}/.well-known/oauth-authorization-server/r/${cell}/tenant1`
    ).then((r) => r.json());
    expect(meta.issuer).toBe(`${asOrigin}/r/${cell}/tenant1`);
    expect(meta.authorization_endpoint).toBe(
      `${asOrigin}/r/${cell}/tenant1/authorize`
    );
  });
});

/**
 * Every hosted auth scenario, driven by the repo's everything-client through
 * a local deployment: the RS app behind an HTTP origin plus one
 * examples/hosted/local-relay.ts relay per aux role, at every revision the
 * scenario applies to.
 *
 * Each deployment is run twice. With one process and no store, /results
 * judges the live scenario. With two processes sharing a store, the RS
 * origin deals requests round-robin between two hosted apps, each behind
 * the fetch bridge valtown.ts uses and flushed before it answers — the way
 * val.town spreads one run over isolates that share no memory. A scenario
 * that keeps state in memory between two requests fails there as it would
 * on val.town, and /results re-judges the merged log in a fresh instance.
 */
const HOSTED_AUTH_SCENARIOS = [
  'auth/basic-cimd',
  'auth/metadata-default',
  'auth/metadata-var1',
  // auth/metadata-var2 is left out: the everything-client's SDK fails its
  // resource-parameter-matches-prm check (see index.test.ts), and val.town
  // excludes it as single-process only.
  'auth/metadata-var3',
  'auth/pre-registration',
  'auth/scope-from-www-authenticate',
  'auth/scope-from-scopes-supported',
  'auth/scope-omitted-when-undefined',
  'auth/scope-step-up',
  'auth/scope-retry-limit',
  'auth/token-endpoint-auth-basic',
  'auth/token-endpoint-auth-post',
  'auth/token-endpoint-auth-none',
  'auth/iss-supported',
  'auth/iss-not-advertised',
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  'auth/metadata-issuer-mismatch',
  'auth/resource-mismatch',
  'auth/offline-access-scope',
  'auth/offline-access-not-supported',
  'auth/authorization-server-migration'
];

/**
 * Scenarios that need one process's memory across requests. The migration
 * scenario's PRM switches authorization servers once a token has been
 * accepted; a process whose replayed log predates that acceptance keeps
 * sending the client to the first one (val.town excludes it too).
 */
const SINGLE_PROCESS_ONLY = new Set<string>([
  'auth/authorization-server-migration'
]);

const AUX_ROLES: AuxOriginRole[] = ['as', 'as2'];

interface Deployment {
  rs: string;
  close(): Promise<void>;
}

async function deploy(processes: number): Promise<Deployment> {
  let handlers: Array<(req: Request) => Promise<Response>> = [];
  let turn = 0;
  const front = await listenFetch(0, (req) =>
    handlers[turn++ % handlers.length](req)
  );
  const rs = originOf(front);
  const relays = await Promise.all(
    AUX_ROLES.map((role) =>
      listenRelay(0, { rsOrigin: rs, secret: RELAY_SECRET, role })
    )
  );
  const auxOrigins = Object.fromEntries(
    AUX_ROLES.map((role, i) => [role, originOf(relays[i])])
  );
  const store = processes > 1 ? new MemoryRunStore() : undefined;
  const apps = Array.from({ length: processes }, () =>
    createHostedApp({ auxOrigins, relaySecret: RELAY_SECRET, store })
  );
  handlers = apps.map(({ app, sessions }) => {
    const bridge = toFetchHandler(app);
    return async (req: Request) => {
      const res = await bridge(req);
      await sessions.flush();
      return res;
    };
  });
  return {
    rs,
    async close() {
      for (const { sessions } of apps) await sessions.close();
      await Promise.all([front, ...relays].map(closeServer));
    }
  };
}

/**
 * The everything-client, imported for `revision`: it picks its lifecycle
 * from MCP_CONFORMANCE_PROTOCOL_VERSION when the module is evaluated, so
 * each revision gets its own copy.
 */
const everythingClients = new Map<
  string,
  Promise<(name: string) => ((url: string) => Promise<void>) | undefined>
>();
function everythingClient(revision: string) {
  let loaded = everythingClients.get(revision);
  if (!loaded) {
    loaded = (async () => {
      process.env.MCP_CONFORMANCE_PROTOCOL_VERSION = revision;
      vi.resetModules();
      const client =
        await import('../../examples/clients/typescript/everything-client');
      const { setLogLevel } =
        await import('../../examples/clients/typescript/helpers/logger');
      setLogLevel('error');
      return client.getHandler;
    })();
    everythingClients.set(revision, loaded);
  }
  return loaded;
}

/** The revisions a scenario is mounted at (every column but `n/a`). */
function revisionsOf(scenario: string): SpecVersion[] {
  const matrix = buildMatrix({ auxOrigins: { as: 'x', as2: 'y' } });
  return matrix.revisions.filter(
    (rev) => matrix.cell(scenario, rev)!.scoring !== 'n/a'
  ) as SpecVersion[];
}

describe.each([
  { label: 'one process', processes: 1 },
  { label: 'two processes sharing a store', processes: 2 }
])('everything-client through the hosted server ($label)', ({ processes }) => {
  let dep: Deployment;
  beforeAll(async () => {
    dep = await deploy(processes);
  });
  afterAll(async () => {
    await dep.close();
    for (const k of [
      'MCP_CONFORMANCE_SCENARIO',
      'MCP_CONFORMANCE_PROTOCOL_VERSION',
      'MCP_CONFORMANCE_CONTEXT'
    ])
      delete process.env[k];
  });

  const scenarios = HOSTED_AUTH_SCENARIOS.filter(
    (s) => processes === 1 || !SINGLE_PROCESS_ONLY.has(s)
  );
  for (const scenario of scenarios) {
    for (const revision of revisionsOf(scenario)) {
      it(`${scenario} passes at ${revision}`, async () => {
        const cell = `p${processes}/${revision}/${scenario}`;
        // What a person would copy from the cell's config page.
        const config = await fetch(`${dep.rs}/s/${cell}?format=json`).then(
          (r) => r.json()
        );
        expect(config.cells).toHaveLength(1);
        const { url, env } = config.cells[0];
        delete process.env.MCP_CONFORMANCE_CONTEXT;
        Object.assign(process.env, env);

        const handler = (await everythingClient(revision))(scenario);
        expect(handler).toBeDefined();
        let clientError: string | undefined;
        try {
          await handler!(url);
        } catch (e) {
          clientError = String(e);
        }

        const results = await fetch(`${dep.rs}/results/${cell}`).then((r) =>
          r.json()
        );
        const failures = results.checks.filter(
          (c: ConformanceCheck) => c.status === 'FAILURE'
        );
        // The client error is shown either way: it usually explains a failure.
        const allowed = getScenario(scenario)?.allowClientError;
        expect({ clientError, failures, verdict: results.verdict }).toEqual({
          clientError: allowed ? clientError : undefined,
          failures: [],
          verdict: 'pass'
        });
      });
    }
  }

  // scope-retry-limit's 410 cut-off counts the answers in each process's
  // copy of the log, so across processes a client that never stops is cut
  // off later. The verdict counts every attempt in the merged log, so it
  // still fails such a client.
  it('auth/scope-retry-limit still fails a client with no retry limit', async () => {
    const cell = `p${processes}-noretry/2025-11-25/auth/scope-retry-limit`;
    const config = await fetch(`${dep.rs}/s/${cell}?format=json`).then((r) =>
      r.json()
    );
    await noRetryLimitClient(config.cells[0].url).catch(() => undefined);
    const results = await fetch(`${dep.rs}/results/${cell}`).then((r) =>
      r.json()
    );
    expect(
      results.checks.find((c: ConformanceCheck) => c.id === 'scope-retry-limit')
    ).toMatchObject({ status: 'FAILURE' });
    expect(results.verdict).toBe('fail');
  });
});

function originOf(server: Server): string {
  return `http://localhost:${(server.address() as { port: number }).port}`;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((r) => server.close(() => r()));
}

function listen(
  app: express.Application,
  capture: (s: Server) => void
): Promise<string> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const a = s.address();
      capture(s);
      resolve(`http://localhost:${(a as { port: number }).port}`);
    });
  });
}

function jsonHeaders() {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
}

function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'vitest', version: '0' },
      capabilities: {}
    }
  };
}
