import { describe, it, expect } from 'vitest';
import handler, { withServerTiming } from './valtown';

// A clock that returns the given readings in order.
function clock(...readings: number[]) {
  return () => {
    const t = readings.shift();
    if (t === undefined) throw new Error('clock read too often');
    return t;
  };
}

function metrics(response: Response): Map<string, string> {
  const header = response.headers.get('server-timing') ?? '';
  return new Map(
    header.split(/,\s*/).map((m) => [m.split(';')[0], m] as [string, string])
  );
}

describe('withServerTiming', () => {
  it('reports cold and boot on the first request only, app and flush on every request', async () => {
    const order: string[] = [];
    const wrapped = withServerTiming(
      async () => {
        order.push('handle');
        return new Response('ok');
      },
      async () => {
        order.push('flush');
      },
      100,
      // arrive, handled, flushed — for two requests
      clock(350, 400.5, 430, 1000, 1012, 1015.25)
    );

    const first = await wrapped(new Request('http://test/a'));
    expect(first.headers.get('server-timing')).toBe(
      'cold;desc="first request in isolate";dur=250, ' +
        'boot;desc="time origin to module evaluation";dur=100, ' +
        'app;dur=50.5, flush;dur=29.5'
    );

    const second = await wrapped(new Request('http://test/b'));
    expect(second.headers.get('server-timing')).toBe(
      'app;dur=12, flush;dur=3.3'
    );
    expect(order).toEqual(['handle', 'flush', 'handle', 'flush']);
  });

  it('preserves status, headers and body, and appends to an existing Server-Timing', async () => {
    const wrapped = withServerTiming(
      async () =>
        new Response('{"a":1}', {
          status: 418,
          statusText: 'teapot',
          headers: {
            'content-type': 'application/json',
            link: '</results/x>; rel="results"',
            'server-timing': 'db;dur=1'
          }
        }),
      async () => {},
      0
    );
    const r = await wrapped(new Request('http://test/'));
    expect(r.status).toBe(418);
    expect(r.statusText).toBe('teapot');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('link')).toBe('</results/x>; rel="results"');
    expect(r.headers.get('server-timing')).toMatch(
      /^db;dur=1, cold;desc="[^"]*";dur=[\d.]+, boot;desc="[^"]*";dur=[\d.]+, app;dur=[\d.]+, flush;dur=[\d.]+$/
    );
    expect(await r.text()).toBe('{"a":1}');
  });

  it('handles immutable headers and a null body', async () => {
    const wrapped = withServerTiming(
      async () => Response.redirect('http://test/elsewhere', 302),
      async () => {},
      0
    );
    const r = await wrapped(new Request('http://test/'));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://test/elsewhere');
    expect(metrics(r).has('app')).toBe(true);
  });

  it('does not buffer a streamed body', async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        push = c;
      }
    });
    const wrapped = withServerTiming(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream' }
        }),
      async () => {},
      0
    );
    // Resolves while the stream is still open: nothing waited for its end.
    const r = await wrapped(new Request('http://test/'));
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    push.enqueue(new TextEncoder().encode('data: 1\n\n'));
    push.close();
    expect(await r.text()).toBe('data: 1\n\n');
  });
});

describe('val.town entry', () => {
  it('adds Server-Timing to real responses, with cold on the first only', async () => {
    const first = await handler(new Request('http://test/scenarios'));
    expect(first.status).toBe(200);
    expect(Array.isArray(await first.json())).toBe(true);
    expect([...metrics(first).keys()]).toEqual([
      'cold',
      'boot',
      'app',
      'flush'
    ]);

    const second = await handler(new Request('http://test/scenarios'));
    expect(second.status).toBe(200);
    await second.text();
    expect([...metrics(second).keys()]).toEqual(['app', 'flush']);
  });
});
