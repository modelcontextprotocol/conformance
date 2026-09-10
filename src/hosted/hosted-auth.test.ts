/**
 * Hosted auth scenarios — RS app + a local relay simulating the AS origin.
 *
 * Mirrors the production topology (RS val.town app + AS relay val) on two
 * ephemeral localhost ports, then walks the OAuth discovery → DCR →
 * authorize → token → MCP flow by hand to prove the path-rewrite and
 * relay-secret guard work end to end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createHostedApp } from './server';
import {
  SessionManager,
  listHostableScenarios,
  finalizeChecks,
  rawChecksOf
} from './session';

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

  it('lists auth/* scenarios as hostable when as-origin is configured', () => {
    const names = listHostableScenarios(['as']);
    expect(names).toContain('auth/basic-cimd');
    expect(names).toContain('auth/metadata-default');
    expect(names).toContain('auth/pre-registration');
    // 3-origin scenarios still excluded with only [as]
    expect(names).not.toContain('auth/authorization-server-migration');
  });

  it('rejects /__aux/* without the relay secret', async () => {
    const res = await fetch(
      `${rs}/__aux/as/.well-known/oauth-authorization-server/r/nope`
    );
    expect(res.status).toBe(403);
  });

  it('locates the /r/<run-id> segment pair in an /__aux path by segments', async () => {
    const hdr = { headers: { 'x-relay-secret': RELAY_SECRET } };
    // No valid /r/<id> pair anywhere (id has an illegal character).
    let res = await fetch(`${rs}/__aux/as/tenant/r/bad!id/token`, hdr);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/missing \/r\/<run-id>/);
    // A well-formed pair for a run that does not exist resolves the id.
    res = await fetch(`${rs}/__aux/as/tenant/r/no-such-run/token`, hdr);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/for run/);
    // Adversarial input that would make the old regex backtrack.
    const evil = '/r/-'.repeat(2000) + '/r/x/token';
    res = await fetch(`${rs}/__aux/as${evil}`, hdr);
    expect(res.status).toBe(404);
  });

  it('walks auth/metadata-default end-to-end through the relay', async () => {
    const runId = 'authflow';
    const mcpUrl = `${rs}/s/auth/metadata-default/${runId}/mcp`;

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
    const prmUrl = `${rs}/.well-known/oauth-protected-resource/s/auth/metadata-default/${runId}/mcp`;
    const prm = await fetch(prmUrl).then((r) => r.json());
    expect(prm.resource).toBe(mcpUrl);
    expect(prm.authorization_servers).toEqual([`${asOrigin}/r/${runId}`]);

    // 3. AS metadata — client derives well-known from issuer per RFC 8414 →
    //    hits the relay origin → forwarded to /__aux/as/… → run resolved.
    const asMeta = await fetch(
      `${asOrigin}/.well-known/oauth-authorization-server/r/${runId}`
    ).then((r) => r.json());
    expect(asMeta.issuer).toBe(`${asOrigin}/r/${runId}`);
    expect(asMeta.authorization_endpoint).toBe(
      `${asOrigin}/r/${runId}/authorize`
    );
    expect(asMeta.token_endpoint).toBe(`${asOrigin}/r/${runId}/token`);

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
    // RFC 9207 iss parameter should be the per-run issuer
    expect(loc.searchParams.get('iss')).toBe(`${asOrigin}/r/${runId}`);

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
    const raw = rawChecksOf(sessions.get(runId)!.scenario).map((c) => ({
      ...c
    }));
    expect(raw.some((c) => c.id.startsWith('resource-parameter-'))).toBe(false);

    // 8. Results — checks from BOTH origins accumulated on the one run.
    const results = await fetch(`${rs}/results/${runId}`).then((r) => r.json());
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

  it('exposes scenarioContext on the start_run response (pre-registration)', async () => {
    const r = await fetch(`${rs}/s/auth/pre-registration`).then((r) =>
      r.json()
    );
    expect(r.context).toEqual({
      name: 'auth/pre-registration',
      client_id: 'pre-registered-client',
      client_secret: 'pre-registered-secret',
      // The AS issuer this run publishes: the relay origin + /r/<run-id>.
      issuer: expect.stringMatching(
        /^http:\/\/localhost:\d+\/r\/[A-Za-z0-9_-]+$/
      )
    });
  });

  it('routes tenant-prefixed AS metadata (auth/metadata-var2) correctly', async () => {
    const runId = 'tenant';
    // Touch RS to lazily create the run so the aux handler exists.
    await fetch(`${rs}/s/auth/metadata-var2/${runId}/mcp`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(initBody())
    });
    // Issuer is <as>/r/<id>/tenant1 → well-known at
    // <as>/.well-known/oauth-authorization-server/r/<id>/tenant1
    const meta = await fetch(
      `${asOrigin}/.well-known/oauth-authorization-server/r/${runId}/tenant1`
    ).then((r) => r.json());
    expect(meta.issuer).toBe(`${asOrigin}/r/${runId}/tenant1`);
    expect(meta.authorization_endpoint).toBe(
      `${asOrigin}/r/${runId}/tenant1/authorize`
    );
  });
});

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
