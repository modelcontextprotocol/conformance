/**
 * sse-retry on a val.town-shaped deployment: each hosted app behind the
 * fetch bridge and withServerTiming, as valtown.ts serves it, with requests
 * dealt round-robin between apps that share only a store. The tool call and
 * the GET that resumes it can then reach different processes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHostedApp } from '../../src/hosted/server';
import { MemoryRunStore } from '../../src/hosted/store';
import { toFetchHandler } from './fetch-bridge';
import { listenFetch } from './local-relay';
import { withServerTiming } from './valtown';

const REV = '2025-11-25';

interface Deployment {
  origin: string;
  apps: ReturnType<typeof createHostedApp>[];
  server: Server;
}

const open: Deployment[] = [];

async function deploy(
  processes: number,
  { store = false, evict = false } = {}
): Promise<Deployment> {
  const shared = store ? new MemoryRunStore() : undefined;
  const apps = Array.from({ length: processes }, () =>
    createHostedApp({ store: shared })
  );
  const handlers = apps.map(({ app, sessions }) => {
    const handle = withServerTiming(
      toFetchHandler(app),
      () => sessions.flush(),
      0
    );
    return async (req: Request) => {
      const res = await handle(req);
      // An isolate that drops every cell between requests.
      if (evict) {
        for (const run of sessions.list())
          await sessions.destroy(run.id, false);
      }
      return res;
    };
  });
  let turn = 0;
  const server = await listenFetch(0, (req) =>
    handlers[turn++ % handlers.length](req)
  );
  const dep = {
    origin: `http://localhost:${(server.address() as { port: number }).port}`,
    apps,
    server
  };
  open.push(dep);
  return dep;
}

afterEach(async () => {
  for (const dep of open.splice(0)) {
    for (const { sessions } of dep.apps) await sessions.close();
    dep.server.closeAllConnections?.();
    await new Promise<void>((r) => dep.server.close(() => r()));
  }
});

async function results(dep: Deployment, cell: string) {
  for (const { sessions } of dep.apps) await sessions.flush();
  return fetch(`${dep.origin}/results/${cell}`).then((r) =>
    r.json()
  ) as Promise<{
    verdict: string;
    checks: Array<{
      id: string;
      status: string;
      details?: Record<string, unknown>;
    }>;
  }>;
}

const statusOf = (checks: Array<{ id: string; status: string }>, id: string) =>
  checks.find((c) => c.id === id)?.status;

describe.each([
  { label: 'one process', processes: 1, store: false, evict: false },
  {
    label: 'two processes sharing a store',
    processes: 2,
    store: true,
    evict: false
  },
  {
    label: 'two processes that forget every cell after each request',
    processes: 2,
    store: true,
    evict: true
  }
])('sse-retry through the val.town entry ($label)', (opts) => {
  it('passes the SDK client, whichever process the reconnect reaches', async () => {
    const dep = await deploy(opts.processes, opts);
    const cell = `sse/${REV}/sse-retry`;
    // What examples/clients/typescript/sse-retry-test.ts does.
    const client = new Client(
      { name: 'sse-retry-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${dep.origin}/s/${cell}/mcp`),
      {
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 10000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 3
        }
      }
    );
    await client.connect(transport);
    const result = await client.request(
      {
        method: 'tools/call',
        params: { name: 'test_reconnection', arguments: {} }
      },
      CallToolResultSchema
    );
    expect(result.content).toEqual([
      { type: 'text', text: 'Reconnection test completed successfully' }
    ]);
    await transport.close();

    const { verdict, checks } = await results(dep, cell);
    expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
    expect({
      verdict,
      reconnect: statusOf(checks, 'client-sse-graceful-reconnect'),
      timing: statusOf(checks, 'client-sse-retry-timing'),
      lastEventId: statusOf(checks, 'client-sse-last-event-id')
    }).toEqual({
      verdict: 'pass',
      reconnect: 'SUCCESS',
      timing: 'SUCCESS',
      lastEventId: 'SUCCESS'
    });
  }, 20_000);
});

describe('sse-retry across processes, by hand', () => {
  it('answers the tool call on the other process and still fails a reconnect that comes too early', async () => {
    // Requests alternate between the two processes: initialize and the tool
    // call reach the first, the notification and the GET the second.
    const dep = await deploy(2, { store: true });
    const cell = `early/${REV}/sse-retry`;
    const url = `${dep.origin}/s/${cell}/mcp`;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': REV
    };
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: REV,
          clientInfo: { name: 'early', version: '0' },
          capabilities: {}
        }
      })
    });
    await init.text();
    const session = { 'mcp-session-id': init.headers.get('mcp-session-id')! };
    await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...session },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      })
    }).then((r) => r.text());
    // The tool call's stream: a priming event, then closed by the server.
    const call = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...session },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'test_reconnection', arguments: {} }
      })
    });
    expect(await call.text()).toContain('id: event-1');
    // Reconnect at once, ignoring the 500 ms retry.
    const get = await fetch(url, {
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': REV,
        'last-event-id': 'event-1',
        ...session
      }
    });
    expect(get.headers.get('mcp-session-id')).toBe(session['mcp-session-id']);
    const reader = get.body!.getReader();
    let seen = '';
    while (!seen.includes('Reconnection test completed')) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    await reader.cancel();
    // Answered on the process that never saw the tool call, with its id.
    expect(seen).toContain('"id":7');
    expect(seen).toContain('id: event-3');

    const { checks } = await results(dep, cell);
    const timing = checks.find((c) => c.id === 'client-sse-retry-timing');
    expect(timing?.status).toBe('FAILURE');
    expect(timing?.details?.actualDelayMs as number).toBeLessThan(450);
    expect(statusOf(checks, 'client-sse-last-event-id')).toBe('SUCCESS');
  });
});
