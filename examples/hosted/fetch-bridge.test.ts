import { describe, it, expect } from 'vitest';
import { toFetchHandler } from './fetch-bridge';

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe('fetch bridge', () => {
  it('hands back a server-sent event stream at its first write, and tells the listener when the client leaves', async () => {
    let closed = false;
    let later!: () => void;
    const handle = toFetchHandler((_req, res) => {
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      later = () => res.write('data: two\n\n');
    });
    // Resolves although the listener never ends the response.
    const r = await handle(new Request('http://test/'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const reader = r.body!.getReader();
    expect(text((await reader.read()).value)).toBe('data: one\n\n');
    later();
    expect(text((await reader.read()).value)).toBe('data: two\n\n');
    await reader.cancel();
    expect(closed).toBe(true);
  });

  it('closes the stream when the listener ends it', async () => {
    const handle = toFetchHandler((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: last\n\n'), 10);
    });
    const r = await handle(new Request('http://test/'));
    expect(await r.text()).toBe('data: one\n\ndata: last\n\n');
  });

  it('buffers any other response until end()', async () => {
    let ended = false;
    const handle = toFetchHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      setTimeout(() => {
        ended = true;
        res.end('1}');
      }, 10);
    });
    const r = await handle(new Request('http://test/'));
    expect(ended).toBe(true);
    expect(await r.json()).toEqual({ a: 1 });
  });
});
