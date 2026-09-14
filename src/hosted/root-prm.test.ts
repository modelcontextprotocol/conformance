/**
 * The origin-root protected resource metadata (./root-prm.ts): a request
 * that names no cell, answered as the root-metadata cell most recently
 * challenged, from whichever process sent the challenge.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { createHostedApp } from './server';
import { MemoryRunStore } from './store';
import {
  ROOT_PRM_AMBIGUOUS_CHECK_ID,
  ROOT_PRM_ATTRIBUTED_CHECK_ID
} from './root-prm';

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

/** An unauthenticated MCP request to the cell: the sign-in challenge. */
async function challenge(dep: Deployment, origin: string, cell: string) {
  const res = await fetch(`${origin}/s/${cell}/mcp`, {
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
        protocolVersion: REV,
        clientInfo: { name: 'vitest', version: '0' },
        capabilities: {}
      }
    })
  });
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
      /Open your auth\/metadata-var2 cell URL first/
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
    ).toMatchObject([{ status: 'INFO' }]);
    expect(checks.some((c) => c.id === ROOT_PRM_AMBIGUOUS_CHECK_ID)).toBe(
      false
    );
    // The scenario itself saw its metadata served.
    expect(
      checks.find((c) => c.id === 'prm-pathbased-requested')
    ).toMatchObject({ status: 'SUCCESS' });
  });

  it('picks the latest of two challenged cells and notes the other', async () => {
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
    ).toMatchObject({ status: 'INFO', details: { otherCells: [first] } });
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
