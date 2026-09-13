#!/usr/bin/env -S npx tsx
/**
 * Run the val.town relay locally for end-to-end testing without deploying.
 * Thin Node http.Server → fetch-handler bridge around valtown-relay.ts.
 *
 *   CONFORMANCE_RS_ORIGIN=http://localhost:3000 \
 *   CONFORMANCE_RELAY_SECRET=dev \
 *   npx tsx examples/hosted/local-relay.ts 3001
 *
 * Imported, it starts nothing: listenRelay() serves one role per call, which
 * is how src/hosted/hosted-auth.test.ts stands up the `as` and `as2` origins.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRelay, type RelayConfig } from './valtown-relay';

/** Serve the relay for `config.role` on `port` (0 for any free port). */
export function listenRelay(
  port: number,
  config: RelayConfig
): Promise<http.Server> {
  return listenFetch(port, createRelay(config));
}

/** Serve a fetch-style handler on `port` (0 for any free port). */
export function listenFetch(
  port: number,
  handler: (req: Request) => Promise<Response>
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://${req.headers.host}${req.url}`;
    const out = await handler(
      new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body ? new Uint8Array(body) : undefined
      })
    );
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 3001);
  const role = process.env.CONFORMANCE_RELAY_ROLE ?? 'as';
  void listenRelay(port, {
    rsOrigin: process.env.CONFORMANCE_RS_ORIGIN,
    secret: process.env.CONFORMANCE_RELAY_SECRET,
    role
  }).then(() => {
    console.error(
      `relay[${role}] listening on http://localhost:${port} → ${process.env.CONFORMANCE_RS_ORIGIN}/__aux`
    );
  });
}
