import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { gzipSync } from 'zlib';
import type { Server } from 'http';

// The relay reads its env at import time, so point it at a mock RS first and
// import lazily.
const SECRET = 'relay-test-secret';
let upstream: Server;
let upstreamOrigin: string;
let seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
let handler: (req: Request) => Promise<Response>;

const METADATA = {
  issuer: 'https://as.example/r/run-1',
  authorization_endpoint: 'https://as.example/r/run-1/authorize',
  token_endpoint: 'https://as.example/r/run-1/token',
  registration_endpoint: 'https://as.example/r/run-1/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  padding: 'x'.repeat(600)
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.headers['x-relay-secret'] !== SECRET) {
      res.writeHead(403).end('{"error":"forbidden"}');
      return;
    }
    if (req.url?.startsWith('/__aux/as/.well-known/')) {
      // Simulate an edge that gzips: content-length is the *compressed* size.
      const gz = gzipSync(Buffer.from(JSON.stringify(METADATA)));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gz.length)
      });
      res.end(gz);
      return;
    }
    if (req.url?.startsWith('/__aux/as/r/run-1/authorize')) {
      res.writeHead(302, { location: 'http://localhost:3000/callback?code=c' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"nope"}');
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  if (addr && typeof addr === 'object')
    upstreamOrigin = `http://localhost:${addr.port}`;
  process.env.CONFORMANCE_RS_ORIGIN = upstreamOrigin;
  process.env.CONFORMANCE_RELAY_SECRET = SECRET;
  process.env.CONFORMANCE_RELAY_ROLE = 'as';
  handler = (await import('./valtown-relay')).default;
});

afterAll(async () => {
  delete process.env.CONFORMANCE_RS_ORIGIN;
  delete process.env.CONFORMANCE_RELAY_SECRET;
  delete process.env.CONFORMANCE_RELAY_ROLE;
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('val.town AS relay', () => {
  it('forwards to /__aux/<role><path> with the shared secret', async () => {
    seen = [];
    const res = await handler(
      new Request(
        'https://as.example/.well-known/oauth-authorization-server/r/run-1',
        { headers: { accept: 'application/json', 'x-relay-secret': 'spoof' } }
      )
    );
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe(
      '/__aux/as/.well-known/oauth-authorization-server/r/run-1'
    );
    expect(seen[0].headers['x-relay-secret']).toBe(SECRET); // not the spoof
    expect(seen[0].headers['x-relay-host']).toBe('as.example');
    expect(seen[0].headers['accept-encoding']).toBe('identity');
  });

  it('re-frames a compressed upstream body so content-length matches the bytes sent', async () => {
    const res = await handler(
      new Request(
        'https://as.example/.well-known/oauth-authorization-server/r/run-1'
      )
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    const text = await res.text();
    // The whole document arrives — this is what a stale compressed
    // content-length used to truncate.
    expect(JSON.parse(text)).toEqual(METADATA);
    const cl = res.headers.get('content-length');
    if (cl !== null) {
      expect(Number(cl)).toBe(Buffer.byteLength(text));
    }
  });

  it('passes redirects through without following them', async () => {
    const res = await handler(
      new Request('https://as.example/r/run-1/authorize?client_id=x')
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/callback?code=c'
    );
  });
});
