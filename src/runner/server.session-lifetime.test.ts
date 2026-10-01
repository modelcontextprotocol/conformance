import http from 'http';
import type { AddressInfo } from 'net';
import { expect, onTestFinished, test } from 'vitest';
import { runServerConformanceTest } from './server';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('closes a connection completed after timeout before the abandoned scenario can use it', async () => {
  const initialized = deferred<http.ServerResponse>();
  const lateActivity = deferred<void>();
  const liveSessions = new Set<string>();
  const events: Array<{ method: string; sessionId?: string }> = [];
  let issuedSessions = 0;

  const respond = (res: http.ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Real SDK Client + StreamableHTTPClientTransport, driven by the actual
  // runner. This wire fixture has room for one live session at a time.
  const server = http.createServer((req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'DELETE') {
      events.push({ method: 'DELETE', sessionId });
      if (sessionId) liveSessions.delete(sessionId);
      res.writeHead(204).end();
      if (sessionId === 's1') lateActivity.resolve();
      return;
    }
    if (req.method === 'GET') {
      events.push({ method: 'GET', sessionId });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const msg = JSON.parse(raw);
      if (msg.method === 'initialize') {
        if (liveSessions.size > 0) {
          events.push({ method: 'REJECT initialize' });
          res.writeHead(503).end('Session capacity exhausted');
          return;
        }
        const sessionId = `s${++issuedSessions}`;
        liveSessions.add(sessionId);
        events.push({ method: 'POST initialize', sessionId });
        res.setHeader('mcp-session-id', sessionId);
        respond(res, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { prompts: {} },
            serverInfo: { name: 'late-connect-probe', version: '0.0.1' }
          }
        });
        return;
      }

      events.push({ method: `POST ${msg.method}`, sessionId });
      if (msg.method === 'notifications/initialized') {
        if (sessionId === 's1') {
          // The SDK awaits this HTTP acknowledgment before connect() resolves.
          // A real session already exists, but ctx.connect() is still pending.
          initialized.resolve(res);
          return;
        }
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'prompts/list' && sessionId === 's2') {
        respond(res, {
          jsonrpc: '2.0',
          id: msg.id,
          result: { prompts: [{ name: 'p', description: 'healthy prompt' }] }
        });
        return;
      }

      respond(res, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      });
      // The unfixed runner hands s1 to the abandoned scenario. Its failed
      // prompts/list skips the scenario's close(), leaving no later sweeper.
      if (sessionId === 's1') lateActivity.resolve();
    });
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  const pendingRun = runServerConformanceTest(
    url,
    'prompts-list',
    undefined,
    '2025-06-18',
    false,
    1000
  );
  const acknowledgment = await initialized.promise;
  const timedOut = await pendingRun;
  expect(timedOut.checks).toContainEqual(
    expect.objectContaining({ id: 'scenario-timeout', status: 'FAILURE' })
  );
  expect([...liveSessions]).toEqual(['s1']);
  expect(events.some((event) => event.method === 'DELETE')).toBe(false);

  events.push({ method: 'runner returned scenario-timeout' });
  acknowledgment.writeHead(202).end();
  // Positive network barrier: either cleanup terminates s1 or the abandoned
  // scenario incorrectly probes it. No quiet-time sleeps decide the result.
  await lateActivity.promise;

  const healthy = await runServerConformanceTest(
    url,
    'prompts-list',
    undefined,
    '2025-06-18'
  );
  const observation = {
    lateSessionDeletes: events.filter(
      (event) => event.sessionId === 's1' && event.method === 'DELETE'
    ).length,
    lateSessionProbes: events.filter(
      (event) =>
        event.sessionId === 's1' && event.method === 'POST prompts/list'
    ).length,
    healthyPromptStatus: healthy.checks.find(
      (check) => check.id === 'prompts-list'
    )?.status,
    healthyFailures: healthy.checks.filter(
      (check) => check.status === 'FAILURE'
    ).length,
    healthySessionDeletes: events.filter(
      (event) => event.sessionId === 's2' && event.method === 'DELETE'
    ).length,
    liveSessions: [...liveSessions]
  };
  // Capture state before any fixture teardown can hide a leaked session.
  console.log('late connection wire events:', JSON.stringify(events));
  console.log('late connection observation:', JSON.stringify(observation));
  expect(observation).toEqual({
    lateSessionDeletes: 1,
    lateSessionProbes: 0,
    healthyPromptStatus: 'SUCCESS',
    healthyFailures: 0,
    healthySessionDeletes: 1,
    liveSessions: []
  });
});
