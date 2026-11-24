import { afterEach, describe, expect, test, vi } from 'vitest';
import { observeStream } from './stateless-stream';

const ack = 'notifications/subscriptions/acknowledged';
const changed = 'notifications/prompts/list_changed';
const wrong = 'notifications/tools/list_changed';
const request = { method: 'POST' };
const url = 'http://localhost/mcp';

// A live, abortable Web stream rather than a finite list of prewritten frames.
// Fake time makes the >1500 ms mutation deterministic and fast in CI.
function mockSubscription(first: string | null = ack, extra?: string) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let closed = false;
  const encode = (method: string) =>
    `data: ${JSON.stringify({ jsonrpc: '2.0', method, params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 1 } } })}\n\n`;
  const push = (method: string) => {
    if (!closed) streamController.enqueue(new TextEncoder().encode(encode(method)));
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        if (first) {
          controller.enqueue(
            new TextEncoder().encode(encode(first) + (extra ? encode(extra) : ''))
          );
        }
        signal.addEventListener('abort', () => {
          if (!closed) {
            closed = true;
            controller.error(signal.reason);
          }
        }, { once: true });
      },
      cancel() {
        closed = true;
      }
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return {
    push,
    close() {
      if (!closed) {
        closed = true;
        streamController.close();
      }
    },
    get closed() { return closed; },
    get signal() { return signal; }
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SEP-2575 bounded subscription observation', () => {
  test('keeps the subscription open through a slower, successful mutation', async () => {
    vi.useFakeTimers();
    const stream = mockSubscription();
    const pending = observeStream(url, request, 2, 1500, async (signal) => {
      await delay(2000);
      expect(signal.aborted).toBe(false);
      stream.push(changed);
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.mutationError).toBeUndefined();
    expect(result.mutationFrames.map((frame) => frame.method)).toEqual([changed]);
    expect(stream.signal.aborted).toBe(true);
    expect(stream.closed).toBe(true);
  });

  test('a genuine missing notification still has no successful mutation frame', async () => {
    vi.useFakeTimers();
    const stream = mockSubscription();
    const pending = observeStream(url, request, 2, 1500, async () => {
      await delay(2000);
    });
    await vi.advanceTimersByTimeAsync(3500);
    const result = await pending;
    expect(result.mutationError).toBeUndefined();
    expect(result.mutationFrames).toEqual([]);
    expect(result.observationComplete).toBe(true);
    expect(stream.closed).toBe(true);
  });

  test('bounds and cancels a hung mutation', async () => {
    vi.useFakeTimers();
    const stream = mockSubscription();
    let triggerAborted = false;
    const pending = observeStream(url, request, 2, 1500, (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          triggerAborted = true;
          reject(signal.reason);
        }, { once: true });
      }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.mutationError).toBe('Diagnostic mutation timed out');
    expect(triggerAborted).toBe(true);
    expect(result.observationComplete).toBe(false);
    expect(stream.closed).toBe(true);
  });

  test('failed mutation is not a completed negative observation', async () => {
    const stream = mockSubscription();
    const result = await observeStream(url, request, 3, 1500, async () => {
      throw new Error('mutation rejected');
    });
    expect(result.mutationError).toBe('Diagnostic mutation failed');
    expect(result.observationComplete).toBe(false);
    expect(stream.closed).toBe(true);
  });

  test('premature EOF is not a completed negative observation', async () => {
    const stream = mockSubscription();
    const result = await observeStream(url, request, 3, 1500, async () => {
      stream.close();
    });
    expect(result.mutationError).toBeUndefined();
    expect(result.observationComplete).toBe(false);
    expect(result.mutationFrames).toEqual([]);
  });

  test('out-of-filter frames remain visible to the caller', async () => {
    const stream = mockSubscription();
    const result = await observeStream(url, request, 2, 1500, async () => {
      stream.push(wrong);
    });
    expect(result.mutationFrames.map((frame) => frame.method)).toEqual([wrong]);
    expect(stream.closed).toBe(true);
  });

  test('a frame parsed before the trigger is not its mutation receipt', async () => {
    const stream = mockSubscription(ack, changed);
    const result = await observeStream(url, request, 2, 1500, async () => {});
    expect(result.frames.map((frame) => frame.method)).toEqual([ack, changed]);
    expect(result.mutationFrames).toEqual([]);
    expect(stream.closed).toBe(true);
  });

  test('no acknowledgment means no mutation', async () => {
    vi.useFakeTimers();
    mockSubscription(null);
    const trigger = vi.fn(async () => {});
    const pending = observeStream(url, request, 2, 1500, trigger);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(trigger).not.toHaveBeenCalled();
    expect(result.mutationError).toContain('acknowledgment');
    expect(result.frames).toEqual([]);
  });

  test('non-mutation probes retain their existing whole-stream deadline', async () => {
    vi.useFakeTimers();
    const stream = mockSubscription(null);
    const pending = observeStream(url, request, 3, 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result.frames).toEqual([]);
    expect(result.mutationError).toBeUndefined();
    expect(stream.closed).toBe(true);
  });
});
