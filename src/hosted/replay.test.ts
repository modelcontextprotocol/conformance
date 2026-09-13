import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import { replay, type Replayed } from './replay';
import { onBodySettled, tapJsonBody } from './body';

interface Seen {
  method?: string;
  header?: string;
  rawHasHeader: boolean;
  streamed: string;
  buffered?: string;
}

/** Answers like the SDK transport: SSE headers, a Uint8Array chunk, end(). */
function sseChild(seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const r = req as IncomingMessage & { header(n: string): string };
    const record: Seen = {
      method: req.method,
      header: r.header('mcp-protocol-version'),
      rawHasHeader: req.rawHeaders.includes('mcp-protocol-version'),
      streamed: ''
    };
    onBodySettled(req, (b) => (record.buffered = b?.toString()));
    req.on('data', (c: Buffer) => (record.streamed += c.toString()));
    req.on('end', () => {
      seen.push(record);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(new TextEncoder().encode('event: message\ndata: {"id":1}\n\n'));
      res.end();
    });
  };
}

/** Never answers. */
const silentChild = () => {};

let server: Server;
let base: string;
const seen: Seen[] = [];

beforeAll(async () => {
  const app = express();
  app.use(tapJsonBody());
  app.post('/parent/:child', (req, res) => {
    onBodySettled(req, async (body) => {
      const child =
        req.params.child === 'silent' ? silentChild : sseChild(seen);
      const replayed: Replayed = await replay(
        req,
        body ?? Buffer.alloc(0),
        (r, s) => child(r, s),
        50
      );
      res.json(replayed);
    });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object')
        base = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('replay', () => {
  it('hands the child the client’s method, headers and body, and captures its answer', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    });
    const res = await fetch(`${base}/parent/sse`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      },
      body
    });
    const replayed = (await res.json()) as Replayed;

    expect(replayed).toEqual({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: message\ndata: {"id":1}\n\n'
    });
    expect(seen[seen.length - 1]).toEqual({
      method: 'POST',
      header: '2026-07-28',
      rawHasHeader: true,
      streamed: body,
      buffered: body
    });
  });

  it('gives up on a child that never answers', async () => {
    const res = await fetch(`${base}/parent/silent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(await res.json()).toEqual({ status: 504, body: '' });
  });
});
