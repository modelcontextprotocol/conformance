/**
 * The origin-root protected resource metadata (./root-prm.ts): a request
 * that names no cell, answered as the root-metadata cell most recently
 * challenged from the same client address, from whichever process sent the
 * challenge, and never recorded in another tester's run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import type { Request as ExpressRequest } from 'express';
import { createHostedApp } from './server';
import { MemoryRunStore } from './store';
import {
  requesterHasher,
  ROOT_PRM_AMBIGUOUS_CHECK_ID,
  ROOT_PRM_ATTRIBUTED_CHECK_ID
} from './root-prm';
import { toFetchHandler } from '../../examples/hosted/fetch-bridge';

const AS = 'http://as.example';
const REV = '2025-11-25';
const VAR2 = 'auth/metadata-var2';

interface Deployment {
  origins: string[];
  apps: ReturnType<typeof createHostedApp>[];
}

const open: Array<{ servers: Server[]; dep: Deployment }> = [];

/** `processes` hosted apps over one store, as serverless isolates. */
async function deploy(processes: number): Promise<Deployment> {
  const store = new MemoryRunStore();
  const apps = Array.from({ length: processes }, () =>
    createHostedApp({ auxOrigins: { as: AS }, relaySecret: 'x', store })
  );
  const servers: Server[] = [];
  const origins: string[] = [];
  for (const { app } of apps) {
    await new Promise<void>((resolve) => {
      const s = app.listen(0, () => {
        servers.push(s);
        origins.push(
          `http://localhost:${(s.address() as { port: number }).port}`
        );
        resolve();
      });
    });
  }
  const dep = { origins, apps };
  open.push({ servers, dep });
  return dep;
}

afterEach(async () => {
  for (const { servers, dep } of open.splice(0)) {
    for (const { sessions } of dep.apps) await sessions.close();
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r())))
    );
  }
});

function initialize(revision = REV): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: revision,
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    })
  };
}

/** An unauthenticated MCP request to the cell: the sign-in challenge. */
async function challenge(dep: Deployment, origin: string, cell: string) {
  const res = await fetch(`${origin}/s/${cell}/mcp`, initialize());
  await res.text();
  for (const { sessions } of dep.apps) await sessions.flush();
  return res.status;
}

async function hostedChecks(origin: string, cell: string) {
  const results = await fetch(`${origin}/results/${cell}`).then((r) =>
    r.json()
  );
  return results.checks as Array<{
    id: string;
    status: string;
    details?: Record<string, unknown>;
  }>;
}

/** Everything the store holds for a cell, as one string. */
async function storedLog(store: MemoryRunStore, cell: string) {
  return JSON.stringify(Array.from((await store.loadChecks(cell)).values()));
}

describe('origin-root protected resource metadata', () => {
  it('says which cell to open when no cell was challenged', async () => {
    const { origins } = await deploy(1);
    const res = await fetch(
      `${origins[0]}/.well-known/oauth-protected-resource`
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.scenarios).toEqual([VAR2]);
    expect(body.error_description).toMatch(
      /Open your auth\/metadata-var2 cell URL first, from the same client/
    );
  });

  it('answers as the challenged cell from another process, after eviction', async () => {
    const dep = await deploy(2);
    const [a, b] = dep.origins;
    const cell = `rp1/${REV}/${VAR2}`;
    expect(await challenge(dep, a, cell)).toBe(401);
    // Neither process holds the cell in memory any more.
    for (const { sessions } of dep.apps) await sessions.destroy(cell, false);

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/'
    ]) {
      const res = await fetch(`${b}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({
        resource: `${b}/s/${cell}`,
        authorization_servers: [`${AS}/r/${cell}/tenant1`]
      });
    }
    for (const { sessions } of dep.apps) await sessions.flush();

    const checks = await hostedChecks(a, cell);
    expect(
      checks.filter((c) => c.id === ROOT_PRM_ATTRIBUTED_CHECK_ID)
    ).toMatchObject([
      { status: 'INFO', details: { matchedBy: 'client-address' } }
    ]);
    expect(checks.some((c) => c.id === ROOT_PRM_AMBIGUOUS_CHECK_ID)).toBe(
      false
    );
    // The scenario itself saw its metadata served.
    expect(
      checks.find((c) => c.id === 'prm-pathbased-requested')
    ).toMatchObject({ status: 'SUCCESS' });
  });

  it('picks the latest of two cells challenged from one client and counts the other', async () => {
    const dep = await deploy(2);
    const [a, b] = dep.origins;
    const first = `rp2a/${REV}/${VAR2}`;
    const second = `rp2b/${REV}/${VAR2}`;
    await challenge(dep, a, first);
    await new Promise((r) => setTimeout(r, 5));
    await challenge(dep, b, second);

    const prm = await fetch(`${a}/.well-known/oauth-protected-resource`).then(
      (r) => r.json()
    );
    expect(prm.resource).toBe(`${a}/s/${second}`);
    for (const { sessions } of dep.apps) await sessions.flush();

    const checks = await hostedChecks(b, second);
    expect(checks.map((c) => c.id)).toContain(ROOT_PRM_ATTRIBUTED_CHECK_ID);
    expect(
      checks.find((c) => c.id === ROOT_PRM_AMBIGUOUS_CHECK_ID)
    ).toMatchObject({
      status: 'INFO',
      details: {
        otherCellCount: 1,
        otherCells: [{ revision: REV, scenario: VAR2 }]
      }
    });
    // The other cell is counted, never named by its run id.
    expect(JSON.stringify(checks)).not.toContain('rp2a');
    expect(
      (await hostedChecks(b, first)).some(
        (c) => c.id === ROOT_PRM_ATTRIBUTED_CHECK_ID
      )
    ).toBe(false);
  });

  it('attributes nothing to a scenario that serves its metadata by path', async () => {
    const dep = await deploy(1);
    const [a] = dep.origins;
    expect(await challenge(dep, a, `rp3/${REV}/auth/metadata-default`)).toBe(
      401
    );
    const res = await fetch(`${a}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(404);
  });
});

const HOST = 'http://rs.example';

/**
 * Two hosted apps over one store, each behind the fetch bridge val.town
 * uses, taking requests in turn. The bridge has no socket, so the client's
 * address is the last X-Forwarded-For hop, the one the platform appends.
 */
function bridged() {
  const store = new MemoryRunStore();
  const apps = Array.from({ length: 2 }, () =>
    createHostedApp({ auxOrigins: { as: AS }, relaySecret: 'x', store })
  );
  open.push({ servers: [], dep: { origins: [], apps } });
  const handlers = apps.map(({ app, sessions }) => {
    const bridge = toFetchHandler(app);
    return async (req: Request) => {
      const res = await bridge(req);
      await sessions.flush();
      return res;
    };
  });
  let turn = 0;
  /** A request as the platform hands it on: `from` is the XFF it set. */
  async function send(path: string, from?: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (from !== undefined) headers.set('x-forwarded-for', from);
    const res = await handlers[turn++ % handlers.length](
      new Request(`${HOST}${path}`, { ...init, headers })
    );
    return { status: res.status, body: await res.text() };
  }
  async function challengeFrom(from: string | undefined, cell: string) {
    const { status } = await send(`/s/${cell}/mcp`, from, initialize());
    return status;
  }
  async function rootPrm(from?: string) {
    const res = await send('/.well-known/oauth-protected-resource', from);
    return { status: res.status, json: JSON.parse(res.body) };
  }
  return {
    store,
    challengeFrom,
    rootPrm,
    storedLog: (cell: string) => storedLog(store, cell)
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('origin-root protected resource metadata, by client address', () => {
  it("answers each tester as their own run and records nothing in the other's", async () => {
    const d = bridged();
    const alice = `alicerun/${REV}/${VAR2}`;
    const bob = `bobrun/${REV}/${VAR2}`;
    expect(await d.challengeFrom('203.0.113.7', alice)).toBe(401);
    await tick();
    // Bob is the latest challenge on the server.
    expect(await d.challengeFrom('198.51.100.20', bob)).toBe(401);

    const forAlice = await d.rootPrm('203.0.113.7');
    expect(forAlice.status).toBe(200);
    expect(forAlice.json.resource).toBe(`${HOST}/s/${alice}`);
    const forBob = await d.rootPrm('198.51.100.20');
    expect(forBob.json.resource).toBe(`${HOST}/s/${bob}`);

    const aliceLog = await d.storedLog(alice);
    const bobLog = await d.storedLog(bob);
    expect(aliceLog).toContain(ROOT_PRM_ATTRIBUTED_CHECK_ID);
    expect(bobLog).toContain(ROOT_PRM_ATTRIBUTED_CHECK_ID);
    for (const log of [aliceLog, bobLog])
      expect(log).not.toContain(ROOT_PRM_AMBIGUOUS_CHECK_ID);
    expect(aliceLog).not.toContain('bobrun');
    expect(bobLog).not.toContain('alicerun');
    // Neither address is kept, only its keyed hash.
    const notes = JSON.stringify(
      Array.from(
        (d.store as unknown as { challenges: Map<string, unknown> }).challenges
      )
    );
    expect(notes).not.toMatch(/203\.0\.113\.7|198\.51\.100\.20/);
  });

  it("does not let a client claim another tester's address", async () => {
    const d = bridged();
    expect(
      await d.challengeFrom('198.51.100.20', `bobrun/${REV}/${VAR2}`)
    ).toBe(401);
    // The client sent Bob's address; the platform appended the real one.
    const forged = await d.rootPrm('198.51.100.20, 192.0.2.99');
    expect(forged.status).toBe(404);
    expect(forged.json.error_description).toMatch(
      /Open your auth\/metadata-var2 cell URL first, from the same client/
    );
    expect(await d.storedLog(`bobrun/${REV}/${VAR2}`)).not.toContain(
      ROOT_PRM_ATTRIBUTED_CHECK_ID
    );
  });

  it('picks the latest revision one client ran back to back', async () => {
    const d = bridged();
    const older = `samerun/${REV}/${VAR2}`;
    const newer = `samerun/2026-07-28/${VAR2}`;
    expect(await d.challengeFrom('203.0.113.7', older)).toBe(401);
    await tick();
    expect(await d.challengeFrom('203.0.113.7', newer)).toBe(401);

    const res = await d.rootPrm('203.0.113.7');
    expect(res.json.resource).toBe(`${HOST}/s/${newer}`);
    const checks = JSON.parse(await d.storedLog(newer)).flat() as Array<{
      id: string;
      details?: unknown;
    }>;
    expect(
      checks.find((c) => c.id === ROOT_PRM_AMBIGUOUS_CHECK_ID)?.details
    ).toEqual({
      path: '/.well-known/oauth-protected-resource',
      otherCellCount: 1,
      otherCells: [{ revision: REV, scenario: VAR2 }]
    });
  });

  it('without any address, answers the latest challenge and names no other run', async () => {
    const d = bridged();
    const first = `firstrun/${REV}/${VAR2}`;
    const second = `secondrun/${REV}/${VAR2}`;
    expect(await d.challengeFrom(undefined, first)).toBe(401);
    await tick();
    expect(await d.challengeFrom(undefined, second)).toBe(401);

    // A client with an address never matches a challenge that had none.
    expect((await d.rootPrm('203.0.113.7')).status).toBe(404);

    const res = await d.rootPrm();
    expect(res.json.resource).toBe(`${HOST}/s/${second}`);
    const log = await d.storedLog(second);
    expect(log).toContain('latest-challenge');
    expect(log).toContain('"otherCellCount":1');
    expect(log).not.toContain('firstrun');
  });
});

describe('requesterHasher', () => {
  const req = (ip: string | undefined, xff?: string) =>
    ({
      ip,
      header: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? xff : undefined
    }) as unknown as ExpressRequest;

  it('hashes the address under the key, and keeps none of it', () => {
    const hash = requesterHasher('secret');
    const h = hash(req('203.0.113.7'));
    expect(h).toMatch(/^[\w-]{22}$/);
    expect(h).not.toContain('203');
    expect(hash(req('203.0.113.7'))).toBe(h);
    expect(hash(req('::ffff:203.0.113.7'))).toBe(h);
    expect(hash(req('203.0.113.8'))).not.toBe(h);
    expect(requesterHasher('other')(req('203.0.113.7'))).not.toBe(h);
  });

  it('reads only the last X-Forwarded-For hop, and only without a socket', () => {
    const hash = requesterHasher('secret');
    const real = hash(req('192.0.2.99'));
    expect(hash(req(undefined, '203.0.113.7, 192.0.2.99'))).toBe(real);
    expect(hash(req(undefined, '203.0.113.7,192.0.2.99 '))).toBe(real);
    // A socket address wins over anything the client sent.
    expect(hash(req('192.0.2.99', '203.0.113.7'))).toBe(real);
    expect(hash(req(undefined))).toBe('');
    expect(hash(req(undefined, ' , '))).toBe('');
  });
});
