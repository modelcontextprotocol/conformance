#!/usr/bin/env -S npx tsx
/**
 * Run the val.town relay locally for end-to-end testing without deploying.
 * Thin Node http.Server → fetch-handler bridge around valtown-relay.ts.
 *
 *   CONFORMANCE_RS_ORIGIN=http://localhost:3000 \
 *   CONFORMANCE_RELAY_SECRET=dev \
 *   npx tsx examples/hosted/local-relay.ts 3001
 */
import http from 'node:http';
import handler from './valtown-relay';

const port = Number(process.argv[2] ?? 3001);

http
  .createServer(async (req, res) => {
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
  })
  .listen(port, () => {
    console.error(
      `relay[${process.env.CONFORMANCE_RELAY_ROLE ?? 'as'}] ` +
        `listening on http://localhost:${port} → ${process.env.CONFORMANCE_RS_ORIGIN}/__aux`
    );
  });
