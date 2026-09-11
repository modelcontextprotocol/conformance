import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { runRemoteConformanceTest, writeRemoteResult } from './remote';
import { createHostedApp } from '../hosted/server';
import type { Server } from 'http';

/**
 * A client-under-test stub: records argv + env to a JSON file named by
 * REMOTE_TEST_OUT, optionally POSTs an `initialize` to the URL it was given
 * (REMOTE_TEST_POST=1) so the real hosted app records checks for the run.
 */
const CLIENT_SCRIPT = `
const fs = require('fs');
const url = process.argv[2];
(async () => {
  let status = null;
  if (process.env.REMOTE_TEST_POST === '1') {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'remote-test', version: '0.0.0' }
        }
      })
    });
    status = res.status;
  }
  fs.writeFileSync(process.env.REMOTE_TEST_OUT, JSON.stringify({
    url,
    scenario: process.env.MCP_CONFORMANCE_SCENARIO,
    context: process.env.MCP_CONFORMANCE_CONTEXT ?? null,
    protocolVersion: process.env.MCP_CONFORMANCE_PROTOCOL_VERSION ?? null,
    status
  }));
  process.exit(process.env.REMOTE_TEST_EXIT ? Number(process.env.REMOTE_TEST_EXIT) : 0);
})();
`;

let tmp: string;
let clientPath: string;
let outPath: string;
const logs: string[] = [];
const log = (l: string) => logs.push(l);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'conformance-remote-'));
  clientPath = path.join(tmp, 'client.cjs');
  outPath = path.join(tmp, 'client-out.json');
  await fs.writeFile(clientPath, CLIENT_SCRIPT);
  process.env.REMOTE_TEST_OUT = outPath;
});

afterAll(async () => {
  delete process.env.REMOTE_TEST_OUT;
  delete process.env.REMOTE_TEST_POST;
  delete process.env.REMOTE_TEST_EXIT;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readClientOut() {
  return JSON.parse(await fs.readFile(outPath, 'utf8'));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object')
        resolve(`http://localhost:${addr.port}`);
    });
  });
}

describe('conformance remote — mocked hosted server', () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];
  let failedCount = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/s/auth/basic-cimd') {
        const runId = url.searchParams.get('runId') ?? 'minted-1';
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            runId,
            mcpUrl: `${base}/s/auth/basic-cimd/${runId}/mcp`,
            resultsUrl: `http://wrong-origin.example/results/${runId}`,
            resultsHtmlUrl: `http://wrong-origin.example/results/${runId}.html`,
            context: { name: 'auth/basic-cimd', client_id: 'abc' }
          })
        );
        return;
      }
      if (url.pathname.startsWith('/results/')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            runId: url.pathname.slice('/results/'.length),
            scenario: 'auth/basic-cimd',
            summary: {
              passed: 2,
              failed: failedCount,
              warnings: 0,
              info: 1,
              skipped: 0,
              total: 3 + failedCount
            },
            checks: [
              {
                id: 'a',
                name: 'a',
                description: 'ok',
                status: 'SUCCESS',
                timestamp: 't'
              }
            ]
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end('{"error":"nope"}');
    });
    base = await listen(server);
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('mints, spawns the client with URL-as-last-arg + env, reads results from the given origin', async () => {
    seen.length = 0;
    const result = await runRemoteConformanceTest({
      url: `${base}/`, // trailing slash is tolerated
      scenario: 'auth/basic-cimd',
      command: `node ${clientPath}`,
      log
    });

    expect(seen[0]).toBe('/s/auth/basic-cimd');
    expect(seen[1]).toBe('/results/minted-1');
    expect(result.runId).toBe('minted-1');
    expect(result.mcpUrl).toBe(`${base}/s/auth/basic-cimd/minted-1/mcp`);
    // results come from --url, not the server-reported origin
    expect(result.resultsUrl).toBe(`${base}/results/minted-1`);
    expect(result.resultsHtmlUrl).toBe(`${base}/results/minted-1.html`);
    expect(result.summary.failed).toBe(0);
    expect(result.failed).toBe(false);
    expect(result.clientOutput.exitCode).toBe(0);

    const out = await readClientOut();
    expect(out.url).toBe(result.mcpUrl);
    expect(out.scenario).toBe('auth/basic-cimd');
    expect(JSON.parse(out.context)).toEqual({
      name: 'auth/basic-cimd',
      client_id: 'abc'
    });
    expect(out.protocolVersion).toBeTruthy();
  });

  it('forwards --run-id as ?runId= and flags summary.failed > 0', async () => {
    seen.length = 0;
    failedCount = 1;
    process.env.REMOTE_TEST_EXIT = '3';
    try {
      const result = await runRemoteConformanceTest({
        url: base,
        scenario: 'auth/basic-cimd',
        command: `node ${clientPath}`,
        runId: 'ci-run-42',
        log
      });
      expect(seen[0]).toBe('/s/auth/basic-cimd?runId=ci-run-42');
      expect(seen[1]).toBe('/results/ci-run-42');
      expect(result.failed).toBe(true);
      expect(result.clientOutput.exitCode).toBe(3);

      const file = path.join(tmp, 'nested', 'result.json');
      await writeRemoteResult(result, file);
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(json.runId).toBe('ci-run-42');
      expect(json.summary.failed).toBe(1);
      expect(json.clientExitCode).toBe(3);
      expect(json.clientOutput).toBeUndefined();
    } finally {
      failedCount = 0;
      delete process.env.REMOTE_TEST_EXIT;
    }
  });

  it('fails loudly when the scenario cannot be minted', async () => {
    await expect(
      runRemoteConformanceTest({
        url: base,
        scenario: 'does-not-exist',
        command: `node ${clientPath}`,
        log
      })
    ).rejects.toThrow(/mint run for 'does-not-exist': HTTP 404/);
  });

  it('fails loudly when the server is unreachable', async () => {
    await expect(
      runRemoteConformanceTest({
        url: 'http://127.0.0.1:1',
        scenario: 'initialize',
        command: `node ${clientPath}`,
        log
      })
    ).rejects.toThrow(/could not reach/);
  });
});

describe('conformance remote — real hosted app', () => {
  let server: Server;
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const hosted = createHostedApp();
    server = hosted.app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (addr && typeof addr === 'object')
      base = `http://localhost:${addr.port}`;
    close = async () => {
      await hosted.sessions.close();
      await new Promise<void>((r) => server.close(() => r()));
    };
  });

  afterAll(() => close());

  it('runs `initialize` end to end and reads the checks the server recorded', async () => {
    process.env.REMOTE_TEST_POST = '1';
    try {
      const result = await runRemoteConformanceTest({
        url: base,
        scenario: 'initialize',
        command: `node ${clientPath}`,
        runId: 'remote-e2e',
        timeout: 20000,
        log
      });
      expect(result.runId).toBe('remote-e2e');
      expect(result.scenario).toBe('initialize');
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.summary.total).toBe(result.checks.length);
      const out = await readClientOut();
      expect(out.status).toBe(200);
      expect(out.url).toBe(result.mcpUrl);
      expect(result.mcpUrl.startsWith(`${base}/s/initialize/remote-e2e`)).toBe(
        true
      );
    } finally {
      delete process.env.REMOTE_TEST_POST;
    }
  });
});
