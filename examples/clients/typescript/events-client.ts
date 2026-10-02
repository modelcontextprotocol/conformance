/**
 * A hand-written Events client over raw JSON-RPC, used as the passing example
 * for the events-client-* scenarios. The TypeScript SDK has no Events support
 * yet (proposed in modelcontextprotocol/typescript-sdk#2945); the poll loop,
 * stream reconnect and refresh loop are kept as separate functions so they
 * can move into an SDK module once there is one.
 *
 * Every option in `EventsClientOptions` defaults to the conformant behaviour.
 * events-broken-clients.ts flips exactly one per client, so each negative test
 * breaks one rule and nothing else.
 */

import http from 'http';
import { randomBytes } from 'crypto';
import { DRAFT_PROTOCOL_VERSION } from '../../../src/types.js';
import { STATELESS_SPEC_VERSIONS } from '../../../src/connection/select.js';

const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

export interface EventsClientOptions {
  /** Only touch `events/*` when the server declared the extension. */
  gateOnExtension: boolean;
  /** Poll again at once while `hasMore` is true. */
  drainOnHasMore: boolean;
  /** Wait the server's `nextPollMs`; when false, always wait 1000ms. */
  respectNextPollMs: boolean;
  pollFloorMs: number;
  /** Take the fresh cursor that comes with `truncated: true`. */
  persistTruncatedCursor: boolean;
  /**
   * Substitute the last eventId (or subscription id) when the server says
   * `cursor: null`. The conformant client never does this.
   */
  replayNullCursor: boolean;
  /** When false, a response without `cursor` ends that subscription. */
  tolerateAbsentCursor: boolean;
  relistOnListChanged: boolean;
  /** When false, refresh a webhook subscription only after it has expired. */
  refreshBeforeExpiry: boolean;
  /** When false, never reconnect a silent push stream. */
  reconnectDeadStream: boolean;
}

export const CONFORMANT: EventsClientOptions = {
  gateOnExtension: true,
  drainOnHasMore: true,
  respectNextPollMs: true,
  pollFloorMs: 1000,
  persistTruncatedCursor: true,
  replayNullCursor: false,
  tolerateAbsentCursor: true,
  relistOnListChanged: true,
  refreshBeforeExpiry: true,
  reconnectDeadStream: true
};

/** Push notifications whose `cursor` is a position to persist. */
const CURSOR_BEARING = new Set([
  'notifications/events/active',
  'notifications/events/event',
  'notifications/events/heartbeat'
]);

/** Used until two frames have arrived to measure the heartbeat interval. */
const ASSUMED_HEARTBEAT_MS = 30000;

type Json = Record<string, any>;
type OnNotification = (message: Json) => void;

/**
 * JSON-RPC over Streamable HTTP, speaking whichever lifecycle the runner
 * resolved: stateless `_meta` per request for 2026-07-28, or an `initialize`
 * handshake for earlier revisions.
 */
class Rpc {
  private nextId = 1;
  private sessionId: string | undefined;
  readonly stateless: boolean;
  readonly version: string;

  constructor(private serverUrl: string) {
    const v = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION;
    this.stateless = v
      ? (STATELESS_SPEC_VERSIONS as readonly string[]).includes(v)
      : false;
    this.version = v ?? DRAFT_PROTOCOL_VERSION;
  }

  /** Connect and return the server's capabilities. */
  async connect(): Promise<Json> {
    if (this.stateless) {
      const result = await this.request('server/discover');
      return result.capabilities ?? {};
    }
    const result = await this.request('initialize', {
      protocolVersion: this.version,
      capabilities: {},
      clientInfo: { name: 'events-conformance-client', version: '1.0.0' }
    });
    await this.notify('notifications/initialized');
    return result.capabilities ?? {};
  }

  private headers(sse: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: sse ? 'text/event-stream' : 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.version
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private body(method: string, params: Json, id?: number): string {
    const p = this.stateless
      ? {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': this.version,
            'io.modelcontextprotocol/clientInfo': {
              name: 'events-conformance-client',
              version: '1.0.0'
            },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      : params;
    return JSON.stringify(
      id === undefined
        ? { jsonrpc: '2.0', method, params: p }
        : { jsonrpc: '2.0', id, method, params: p }
    );
  }

  async notify(method: string, params: Json = {}): Promise<void> {
    await fetch(this.serverUrl, {
      method: 'POST',
      headers: this.headers(false),
      body: this.body(method, params)
    });
  }

  /**
   * Send a request and return its result. Notifications that arrive on an SSE
   * response ahead of the result go to `onNotification`.
   */
  async request(
    method: string,
    params: Json = {},
    onNotification?: OnNotification,
    signal?: AbortSignal
  ): Promise<Json> {
    const id = this.nextId++;
    const res = await fetch(this.serverUrl, {
      method: 'POST',
      headers: this.headers(false),
      body: this.body(method, params, id),
      signal
    });
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    let reply: Json | undefined;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const message of sseMessages(res, signal)) {
        if (message.id === id) {
          reply = message;
          break;
        }
        if (message.method) onNotification?.(message);
      }
    } else {
      reply = (await res.json()) as Json;
    }
    if (!reply) throw new Error(`${method}: stream ended without a response`);
    if (reply.error) {
      throw new Error(
        `${method} failed: ${reply.error.code} ${reply.error.message}`
      );
    }
    return reply.result ?? {};
  }

  /**
   * Open an `events/stream` request and hand every frame to `onMessage` until
   * the stream ends or `signal` aborts.
   */
  async stream(
    params: Json,
    onMessage: OnNotification,
    signal: AbortSignal
  ): Promise<void> {
    const id = this.nextId++;
    const res = await fetch(this.serverUrl, {
      method: 'POST',
      headers: this.headers(true),
      body: this.body('events/stream', params, id),
      signal
    });
    for await (const message of sseMessages(res, signal)) {
      onMessage(message);
      if (message.id === id) return;
    }
  }
}

async function* sseMessages(
  res: Response,
  signal?: AbortSignal
): AsyncGenerator<Json> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data.trim()) yield JSON.parse(data) as Json;
      }
    }
  } catch (err) {
    if (!signal?.aborted) throw err;
  } finally {
    reader.releaseLock();
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * The cursor to persist from a delivery. `null` and an absent field both mean
 * "nothing to persist"; only the deliberately broken client invents one.
 */
function nextCursor(
  delivered: unknown,
  fallback: string | undefined,
  opts: EventsClientOptions
): string | null {
  if (typeof delivered === 'string') return delivered;
  return opts.replayNullCursor && fallback ? fallback : null;
}

interface Session {
  rpc: Rpc;
  opts: EventsClientOptions;
  stop: AbortSignal;
  relist: () => void;
}

/** One poll loop per subscription, as the sketch requires. */
export async function pollLoop(s: Session, name: string): Promise<void> {
  const { rpc, opts, stop } = s;
  let cursor: string | null = null;
  while (!stop.aborted) {
    const result = await rpc.request(
      'events/poll',
      { name, arguments: {}, cursor },
      (m) => {
        if (m.method === 'notifications/events/list_changed') s.relist();
      }
    );
    if (!('cursor' in result) && !opts.tolerateAbsentCursor) {
      throw new Error(`events/poll for ${name} returned no cursor`);
    }
    const events = Array.isArray(result.events) ? result.events : [];
    const lastId = events[events.length - 1]?.eventId as string | undefined;
    if (!(result.truncated === true && !opts.persistTruncatedCursor)) {
      cursor = nextCursor(result.cursor, lastId ?? cursor ?? undefined, opts);
    }

    if (result.hasMore === true && opts.drainOnHasMore) continue;
    const asked =
      typeof result.nextPollMs === 'number' ? result.nextPollMs : 1000;
    const wait = opts.respectNextPollMs ? asked : 1000;
    await sleep(Math.max(wait, opts.pollFloorMs), stop);
  }
}

/**
 * Hold an `events/stream` open, treating it as dead after two heartbeat
 * intervals of silence and reconnecting with the last cursor. The interval is
 * measured from the frames seen, since the server never announces it.
 */
export async function pushLoop(s: Session, name: string): Promise<void> {
  const { rpc, opts, stop } = s;
  let cursor: string | null = null;
  while (!stop.aborted) {
    const conn = new AbortController();
    const onStop = () => conn.abort();
    stop.addEventListener('abort', onStop, { once: true });

    let lastFrameAt = Date.now();
    let interval: number | undefined;
    let lastHeartbeatAt: number | undefined;
    const watchdog = setInterval(() => {
      const deadAfter = 2 * (interval ?? ASSUMED_HEARTBEAT_MS);
      if (opts.reconnectDeadStream && Date.now() - lastFrameAt > deadAfter) {
        conn.abort();
      }
    }, 100);

    try {
      await rpc.stream(
        { name, arguments: {}, cursor },
        (m) => {
          const now = Date.now();
          if (!m.method?.startsWith('notifications/events/')) return;
          lastFrameAt = now;
          // Heartbeats are the liveness signal, so the cadence is measured
          // between them only; an event can land right after `active`.
          if (m.method === 'notifications/events/heartbeat') {
            if (lastHeartbeatAt !== undefined) {
              interval = Math.max(interval ?? 0, now - lastHeartbeatAt);
            }
            lastHeartbeatAt = now;
          }
          if (CURSOR_BEARING.has(m.method)) {
            const params = m.params ?? {};
            cursor = nextCursor(
              params.cursor,
              params.eventId ?? cursor ?? undefined,
              opts
            );
          }
        },
        conn.signal
      );
    } catch (err) {
      if (!conn.signal.aborted) throw err;
    } finally {
      clearInterval(watchdog);
      stop.removeEventListener('abort', onStop);
    }
    if (!opts.reconnectDeadStream)
      await sleep(Number.MAX_SAFE_INTEGER / 2, stop);
  }
}

/** Subscribe once and keep refreshing before each grant expires. */
export async function webhookLoop(
  s: Session,
  name: string,
  callbackUrl: string
): Promise<void> {
  const { rpc, opts, stop } = s;
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  let cursor: string | null = null;
  while (!stop.aborted) {
    const result = await rpc.request('events/subscribe', {
      name,
      arguments: {},
      delivery: { mode: 'webhook', url: callbackUrl, secret },
      cursor
    });
    cursor = nextCursor(result.cursor, result.id ?? undefined, opts);
    if (result.refreshBefore === null) return;
    const left = Date.parse(result.refreshBefore) - Date.now();
    await sleep(opts.refreshBeforeExpiry ? left / 2 : left + 500, stop);
  }
}

/** A receiver that accepts every delivery, so the callback URL is real. */
async function startReceiver(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/events`,
    close: () => server.close()
  };
}

function durationFromContext(): number {
  try {
    const ctx = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}');
    return typeof ctx.durationMs === 'number' ? ctx.durationMs : 8000;
  } catch {
    return 8000;
  }
}

/**
 * The scenario contract from src/scenarios/client/events/helpers.ts: connect,
 * gate on the extension, list, subscribe to every type in the mode its
 * descriptor names, run for `durationMs`, stop.
 */
export function makeEventsClient(
  opts: EventsClientOptions = CONFORMANT
): (serverUrl: string) => Promise<void> {
  return async (serverUrl: string) => {
    // Read before the first await: the runner's env is process-wide.
    const durationMs = durationFromContext();
    const rpc = new Rpc(serverUrl);
    const caps = await rpc.connect();
    if (opts.gateOnExtension && !caps.extensions?.[EVENTS_EXTENSION_ID]) return;

    const stopper = new AbortController();
    const session: Session = {
      rpc,
      opts,
      stop: stopper.signal,
      relist: () => {
        if (opts.relistOnListChanged) {
          rpc.request('events/list').catch(() => undefined);
        }
      }
    };

    const listed = await rpc.request('events/list');
    const descriptors: Json[] = Array.isArray(listed.events)
      ? listed.events
      : [];
    const receiver = descriptors.some((d) => d.delivery?.[0] === 'webhook')
      ? await startReceiver()
      : undefined;

    const timer = setTimeout(() => stopper.abort(), durationMs);
    const loops = descriptors.map((d) => {
      const mode = Array.isArray(d.delivery) ? d.delivery[0] : 'poll';
      const run =
        mode === 'push'
          ? pushLoop(session, d.name)
          : mode === 'webhook'
            ? webhookLoop(session, d.name, receiver!.url)
            : pollLoop(session, d.name);
      return run.catch((err) => {
        console.error(`[events-client] ${d.name}: ${err}`);
      });
    });

    await Promise.all(loops);
    clearTimeout(timer);
    stopper.abort();
    receiver?.close();
  };
}
