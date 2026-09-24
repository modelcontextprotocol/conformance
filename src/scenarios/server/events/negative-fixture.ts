/**
 * The fixture the MCP Events negative controls are graded against.
 *
 * One server, five scenarios. Every option here exists to break exactly one
 * rule while leaving the rest of the wire conformant, which is what makes a
 * negative control a control: if two things are wrong at once, a flipped check
 * does not say which one it caught.
 *
 * It speaks the SEP-2575 stateless wire (`server/discover` plus one POST per
 * request), built per test rather than checked in as an example server, which
 * matches the SEP-2640 negative tests. `events/stream` is a real SSE response
 * held open with timers rather than a canned transcript, because the heartbeat
 * cadence and the cancellation rows are about timing.
 */

import { EVENTS_EXTENSION_ID } from './helpers';
import { createHash, createHmac } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { withRequiredDraftResultFields } from '../../../mock-server';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { SUBSCRIPTION_ID_META } from './helpers';

/** A descriptor that is well formed apart from whatever a test overrides. */
export function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test.event',
    description: 'A negative-control fixture event type.',
    delivery: ['poll'],
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' } }
    },
    payloadSchema: { type: 'object', properties: { id: { type: 'string' } } },
    ...overrides
  };
}

/** A poll result that is well formed apart from whatever a test overrides. */
export function pollResult(overrides: Record<string, unknown> = {}) {
  return {
    events: [],
    cursor: 'cursor_001',
    truncated: false,
    hasMore: false,
    nextPollMs: 30000,
    ...overrides
  };
}

/** An occurrence that is well formed apart from whatever a test overrides. */
export function occurrence(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt_001',
    name: 'test.event',
    timestamp: '2026-09-15T12:00:00Z',
    data: { id: 'x' },
    ...overrides
  };
}

export type JsonRpcErrorShape = { code: number; message: string };

/** A queued poll answer: a result body, or an error to answer with instead. */
export type PollAnswer = Record<string, unknown> | { error: JsonRpcErrorShape };

/**
 * How `events/stream` behaves. The defaults are conformant: an immediate
 * `active` confirmation carrying the parent request id in `_meta`, a heartbeat
 * with a cursor, and one well-formed event.
 */
export interface StreamBehaviour {
  /** Answer the POST with this JSON-RPC error instead of opening a stream. */
  error?: JsonRpcErrorShape;
  /** Answer the POST with a plain JSON result, which is not a stream at all. */
  answerJson?: boolean;
  /** Send no `notifications/events/active`. */
  omitActive?: boolean;
  /** Fields merged into the `active` params. */
  activeParams?: Record<string, unknown>;
  /**
   * Where the parent request id goes. `meta` is the spelling the document
   * requires; `requestId` is the one kitchen-sink ships; `none` omits it.
   */
  correlation?: 'meta' | 'requestId' | 'none';
  /** Heartbeat cadence. 0 sends none. */
  heartbeatMs?: number;
  /** Fields merged into each heartbeat's params. */
  heartbeatParams?: Record<string, unknown>;
  /** Send `: keepalive` SSE comment lines at the heartbeat cadence too. */
  sseComments?: boolean;
  /** Deliver an event this long after the stream opens. 0 sends none. */
  eventAfterMs?: number;
  /** Fields merged into the delivered event's params. */
  eventParams?: Record<string, unknown>;
  /** Ride a non-`notifications/events/*` notification on the stream. */
  foreignNotification?: string;
  /** Send `notifications/events/error` after this long. */
  errorNotificationAfterMs?: number;
  /** Send `notifications/events/terminated` after this long. */
  terminatedAfterMs?: number;
  /** Send a second `active` with `truncated: true`, the retention-gap signal. */
  gapAfterMs?: number;
  /** Close the stream from the server side, writing a final frame first. */
  closeAfterMs?: number;
  /** The `result` of that final frame. Defaults to an empty typed result. */
  finalResult?: Record<string, unknown>;
  /** Refuse concurrent opens past this many, the cap streams are exempt from. */
  maxConcurrent?: number;
  /** Open a stream for any name, including one the catalog does not serve. */
  acceptAnyName?: boolean;
}

const CONFORMANT_STREAM: Required<
  Pick<
    StreamBehaviour,
    'correlation' | 'heartbeatMs' | 'eventAfterMs' | 'maxConcurrent'
  >
> = {
  correlation: 'meta',
  heartbeatMs: 150,
  eventAfterMs: 80,
  maxConcurrent: Infinity
};

/**
 * How `events/subscribe` and `events/unsubscribe` behave. The defaults are
 * conformant: an https-only callback, a validated `whsec_` secret, an id
 * derived from the whole key, an idempotent upsert, and `-32011 NotFound` for
 * a key the server does not hold.
 */
export interface SubscribeBehaviour {
  /** Answer every subscribe with this error instead of subscribing. */
  error?: JsonRpcErrorShape;
  /** Accept a subscribe carrying no `delivery.secret`. */
  acceptMissingSecret?: boolean;
  /** Accept a secret without the `whsec_` prefix. */
  acceptBadPrefix?: boolean;
  /** Accept a `whsec_` secret that decodes to fewer than 24 bytes. */
  acceptShortSecret?: boolean;
  /** Accept an `http://` callback URL. */
  acceptHttpUrl?: boolean;
  /** Code for a rejected secret or URL, where the document says -32602. */
  rejectionCode?: number;
  /** Subscribe to a type whose `delivery` does not list `webhook`. */
  acceptNonWebhookType?: boolean;
  /** Grant `refreshBefore: null` however finite the suggestion. */
  nullRefreshAlways?: boolean;
  /** Grant `refreshBefore: null` when `ttlMs` was omitted. */
  nullRefreshOnOmitted?: boolean;
  /** Grant a `refreshBefore` well past the suggestion. */
  grantBeyondSuggestion?: boolean;
  /** Raw `refreshBefore` to answer with, for the non-timestamp case. */
  refreshBefore?: unknown;
  /** Reject a `ttlMs` the server dislikes instead of clamping it. */
  rejectTtl?: 'short' | 'long' | 'both';
  /** Fields merged into every subscribe result. */
  result?: Record<string, unknown>;
  /** Omit `id` from the subscribe result. */
  omitId?: boolean;
  /** Mint a fresh id per call, so a repeat subscribe is not an upsert. */
  nonIdempotentId?: boolean;
  /** Derive the id from `(name, arguments)` only, leaving the URL out. */
  idIgnoresUrl?: boolean;
  /** Treat a supplied `id` as addressing that subscription. */
  idIsAnInput?: boolean;
  /** Answer success for an unsubscribe of a key never held. */
  unsubscribeUnknownOk?: boolean;
  /** Code for an unsubscribe of an unknown key, where the document says -32011. */
  unsubscribeUnknownCode?: number;
  /** Code for an unsubscribe of a key the server does hold. */
  unsubscribeHeldCode?: number;
  /** Answer -32013 once this many subscriptions are live. */
  maxSubscriptions?: number;
}

/**
 * What the fixture POSTs to a webhook callback once a subscription exists. The
 * defaults are conformant: a verification challenge first, then one event, both
 * signed per Standard Webhooks with the decoded secret bytes, both carrying
 * `X-MCP-Subscription-Id`, retried on 5xx with a fresh timestamp and signature,
 * and never retried after 410 or 413.
 *
 * Delivering at all is what a *loopback* callback makes wrong, so the SSRF rows
 * fail whenever this is switched on without `EVENTS_WEBHOOK_CALLBACK_BASE`.
 * That is the fixture standing in for a server run with its private-network
 * guard disabled, which is the state the demo fixtures ship in.
 */
export interface DeliveryBehaviour {
  /** Send the verification envelope before any event. */
  verify?: boolean;
  /**
   * Run the handshake inside `events/subscribe`, before answering, and refuse
   * with -32015 `challenge_failed` when the callback does not echo the nonce
   * in a 2xx body. The default challenges after the response and ignores the
   * answer.
   */
  synchronousVerification?: boolean;
  /** With `synchronousVerification`, accept the subscription anyway. */
  ignoreFailedEcho?: boolean;
  /** Deliver an event at all. */
  sendEvent?: boolean;
  /** Deliver the event before the verification envelope. */
  eventBeforeVerification?: boolean;
  /** Sign with the literal `whsec_…` string instead of its decoded bytes. */
  literalKeySignature?: boolean;
  /** Standard Webhooks headers to leave off. */
  omitHeaders?: string[];
  /** Leave off `X-MCP-Subscription-Id`. */
  omitSubscriptionIdHeader?: boolean;
  /** Send an `X-MCP-Subscription-Id` that is not the subscribe response's id. */
  wrongSubscriptionIdHeader?: boolean;
  /** Deliver with this method instead of POST. */
  method?: string;
  /** Deliver with this Content-Type instead of application/json. */
  contentType?: string;
  /** Pad the event body past the 256 KiB ceiling. */
  oversizedBody?: boolean;
  /** Follow a 302 from the callback, which the document forbids. */
  followRedirects?: boolean;
  /** Total attempts for a delivery the callback rejects with 5xx. */
  attempts?: number;
  /** Milliseconds between retry attempts; defaults to just over a second. */
  retryGapMs?: number;
  /** Reuse the first attempt's timestamp and signature on every retry. */
  staleRetrySignature?: boolean;
  /** Retry after 410 and 413, which the document defines as non-retryable. */
  retryNonRetryable?: boolean;
  /** Sign control envelopes the way deliveries are signed. */
  signEnvelopes?: boolean;
  /** `webhook-id` form for control envelopes. */
  envelopeIdFormat?: 'msg' | 'plain';
  /** Send a `gap` control envelope. */
  gapEnvelope?: boolean | { cursor?: unknown };
  /** Send a `terminated` control envelope. */
  terminatedEnvelope?: boolean | { error?: unknown };
}

/**
 * The restart, generation and subscription-state controls, for the TTL
 * durability rows. Defaults are conformant: both grants survive a restart and
 * nothing is garbage-collected.
 */
export interface DurabilityBehaviour {
  /** Drop a no-expiry subscription this long after it was created. */
  gcAfterMs?: number;
  /** Lose no-expiry subscriptions across a restart. */
  dropNoExpiryOnRestart?: boolean;
  /** Lose finite subscriptions across a restart. */
  dropFiniteOnRestart?: boolean;
  /** Answer the restart control without restarting. */
  restartNoop?: boolean;
}

export interface EventsFixtureOptions {
  /** Expose the durability controls as tools. */
  durability?: DurabilityBehaviour;
  /**
   * Raw value to declare at `capabilities.extensions["io.modelcontextprotocol/events"]`;
   * omit for no declaration.
   */
  capability?: unknown;
  descriptors?: object[];
  /** Answer `events/list` with this JSON-RPC error instead of a result. */
  listError?: JsonRpcErrorShape;
  /**
   * Poll responses, consumed in order; the last one repeats once exhausted.
   * A `{ error }` entry makes that poll answer with a JSON-RPC error.
   */
  pollResponses?: PollAnswer[];
  /** Overrides keyed by the polled event name, taking priority over the queue. */
  pollByName?: Record<string, PollAnswer>;
  /** Error code for a poll naming an event type the fixture does not serve. */
  unknownNameCode?: number;
  /** Error code for a poll whose arguments violate `inputSchema`. */
  invalidArgsCode?: number;
  /** How `events/stream` behaves. */
  stream?: StreamBehaviour;
  /** How `events/subscribe` and `events/unsubscribe` behave. */
  subscribe?: SubscribeBehaviour;
  /**
   * What the fixture POSTs to the callback. Omit it and the fixture subscribes
   * without ever delivering, which is what a server with no webhook delivery
   * looks like from the receiver's side.
   */
  delivery?: DeliveryBehaviour;
}

export interface EventsFixture {
  url: string;
  /** Params of every `events/poll` received, in order. */
  polls: Array<Record<string, unknown>>;
  /** Params of every `events/stream` received, in order. */
  streams: Array<Record<string, unknown>>;
  /** Params of every `events/subscribe` received, in order. */
  subscribes: Array<Record<string, unknown>>;
  /** Subscription keys the fixture still holds when it is asked. */
  liveSubscriptions(): string[];
  close(): Promise<void>;
}

/** `whsec_` plus base64 of 24–64 bytes, which is what the document requires. */
function secretProblem(
  secret: unknown,
  behaviour: SubscribeBehaviour
): 'missing' | 'prefix' | 'length' | undefined {
  if (secret === undefined || secret === null) {
    return behaviour.acceptMissingSecret ? undefined : 'missing';
  }
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) {
    return behaviour.acceptBadPrefix ? undefined : 'prefix';
  }
  const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (bytes.length < 24 || bytes.length > 64) {
    return behaviour.acceptShortSecret ? undefined : 'length';
  }
  return undefined;
}

export async function startEventsFixture(
  opts: EventsFixtureOptions
): Promise<EventsFixture> {
  const polls: Array<Record<string, unknown>> = [];
  const streams: Array<Record<string, unknown>> = [];
  const subscribes: Array<Record<string, unknown>> = [];
  /** Live subscriptions, keyed the way the document keys them. */
  const subscriptions = new Map<
    string,
    { id: string; noExpiry?: boolean; at?: number }
  >();
  let generation = 1;
  /** Deliveries still in flight, so close() can settle rather than abandon. */
  const inFlight = new Set<Promise<void>>();
  let mintedIds = 0;
  const queue = [...(opts.pollResponses ?? [pollResult()])];
  const descriptors = opts.descriptors ?? [descriptor()];
  const names = new Set(
    descriptors
      .map((d) => (d as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string')
  );

  /** Open streams, so close() can tear them down instead of hanging on them. */
  const openStreams = new Set<{ res: ServerResponse; stop: () => void }>();
  let liveStreams = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readJsonBody(req);
    const method = body.method as string;
    const id = body.id;
    const params = (body.params ?? {}) as Record<string, unknown>;

    const send = (result: object) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: withRequiredDraftResultFields(method, result)
        })
      );
    };
    const fail = (code: number, message: string, data?: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })
      );
    };

    if (opts.durability && method === 'tools/list') {
      const obj = { type: 'object', properties: {} };
      send({
        tools: [
          { name: 'events_conformance_restart', inputSchema: obj },
          { name: 'events_conformance_generation', inputSchema: obj },
          { name: 'events_conformance_subscription_state', inputSchema: obj }
        ]
      });
      return;
    }
    if (opts.durability && method === 'tools/call') {
      const d = opts.durability;
      const text = (t: string) =>
        send({ content: [{ type: 'text', text: t }] });
      const tool = params.name;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      if (tool === 'events_conformance_restart') {
        if (d.restartNoop) {
          text(String(generation + 1));
          return;
        }
        generation++;
        for (const [key, sub] of [...subscriptions.entries()]) {
          if (sub.noExpiry ? d.dropNoExpiryOnRestart : d.dropFiniteOnRestart) {
            subscriptions.delete(key);
          }
        }
        text(String(generation));
        return;
      }
      if (tool === 'events_conformance_generation') {
        text(String(generation));
        return;
      }
      if (tool === 'events_conformance_subscription_state') {
        const entry = [...subscriptions.entries()].find(
          ([, sub]) => sub.id === toolArgs.id
        );
        if (!entry) {
          text('absent');
          return;
        }
        const [key, sub] = entry;
        if (
          d.gcAfterMs !== undefined &&
          sub.noExpiry &&
          Date.now() - (sub.at ?? 0) > d.gcAfterMs
        ) {
          subscriptions.delete(key);
          text('absent');
          return;
        }
        text('active');
        return;
      }
      fail(-32602, `unknown tool ${String(tool)}`);
      return;
    }

    if (method === 'server/discover') {
      send({
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities:
          'capability' in opts
            ? { extensions: { [EVENTS_EXTENSION_ID]: opts.capability } }
            : {},
        serverInfo: { name: 'events-negative', version: '1.0.0' }
      });
      return;
    }

    if (method === 'events/list') {
      if (opts.listError) {
        fail(opts.listError.code, opts.listError.message);
        return;
      }
      send({ events: descriptors });
      return;
    }

    if (method === 'events/poll') {
      polls.push(params);
      const name = params.name;

      if (typeof name !== 'string') {
        fail(-32602, 'InvalidParams: `name` is required');
        return;
      }
      if (!names.has(name)) {
        fail(opts.unknownNameCode ?? -32011, 'NotFound', { kind: 'event' });
        return;
      }

      const byName = opts.pollByName?.[name];
      const chosen =
        byName ??
        (queue.length > 1 ? queue.shift()! : (queue[0] ?? pollResult()));

      // Argument validation against the fixture's own declared schema, so the
      // invalid-arguments probe has something real to violate.
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const decl = descriptors.find(
        (d) => (d as { name?: unknown }).name === name
      ) as { inputSchema?: { properties?: Record<string, { type?: string }> } };
      for (const [key, value] of Object.entries(args)) {
        const declared = decl?.inputSchema?.properties?.[key];
        if (declared?.type === 'string' && typeof value !== 'string') {
          fail(opts.invalidArgsCode ?? -32602, 'InvalidParams');
          return;
        }
      }

      if ('error' in chosen) {
        const e = (chosen as { error: JsonRpcErrorShape }).error;
        fail(e.code, e.message);
        return;
      }
      send(chosen as Record<string, unknown>);
      return;
    }

    if (method === 'events/subscribe' || method === 'events/unsubscribe') {
      const behaviour = opts.subscribe ?? {};
      const delivery = isRecord(params.delivery) ? params.delivery : {};
      const name = params.name;
      const url = delivery.url;
      // The document's key, minus the principal a single run cannot vary.
      const key = [
        behaviour.idIgnoresUrl ? '' : String(url),
        String(name),
        JSON.stringify(params.arguments ?? {})
      ].join('|');

      if (method === 'events/unsubscribe') {
        const held = subscriptions.has(key);
        if (held && behaviour.unsubscribeHeldCode !== undefined) {
          fail(behaviour.unsubscribeHeldCode, 'Unsubscribe refused');
          return;
        }
        if (held) {
          subscriptions.delete(key);
          send({});
          return;
        }
        if (behaviour.unsubscribeUnknownOk) {
          send({});
          return;
        }
        fail(behaviour.unsubscribeUnknownCode ?? -32011, 'NotFound', {
          kind: 'subscription'
        });
        return;
      }

      subscribes.push(params);
      if (behaviour.error) {
        fail(behaviour.error.code, behaviour.error.message);
        return;
      }

      const rejectionCode = behaviour.rejectionCode ?? -32602;
      const problem = secretProblem(delivery.secret, behaviour);
      if (problem) {
        fail(rejectionCode, `InvalidParams: \`delivery.secret\` (${problem})`);
        return;
      }
      if (
        !behaviour.acceptHttpUrl &&
        (typeof url !== 'string' || !url.startsWith('https://'))
      ) {
        fail(rejectionCode, 'InvalidParams: `delivery.url` must be https');
        return;
      }

      const served = descriptors.find(
        (d) => (d as { name?: unknown }).name === name
      ) as { delivery?: unknown } | undefined;
      if (!served) {
        fail(opts.unknownNameCode ?? -32011, 'NotFound', { kind: 'event' });
        return;
      }
      const modes = Array.isArray(served.delivery) ? served.delivery : [];
      if (!modes.includes('webhook') && !behaviour.acceptNonWebhookType) {
        fail(-32014, 'Unsupported: event type does not offer webhook delivery');
        return;
      }

      const ttl = params.ttlMs;
      const reject = behaviour.rejectTtl;
      const shortTtl = typeof ttl === 'number' && ttl <= 60_000;
      const longTtl = typeof ttl === 'number' && ttl > 7 * 24 * 3600_000;
      if (
        (reject === 'both' && (shortTtl || longTtl)) ||
        (reject === 'short' && shortTtl) ||
        (reject === 'long' && longTtl)
      ) {
        fail(-32602, 'InvalidParams: `ttlMs` out of range');
        return;
      }

      // An `id` supplied by the caller is a routing handle, never an input, so
      // by default it has no bearing on which subscription this addresses.
      const addressed =
        behaviour.idIsAnInput && typeof params.id === 'string'
          ? [...subscriptions.entries()].find(
              ([, sub]) => sub.id === params.id
            )?.[0]
          : undefined;
      const effectiveKey = addressed ?? key;

      const existing = subscriptions.get(effectiveKey);
      if (
        !existing &&
        behaviour.maxSubscriptions !== undefined &&
        subscriptions.size >= behaviour.maxSubscriptions
      ) {
        fail(-32013, 'ResourceExhausted: subscription cap reached');
        return;
      }
      const id =
        existing && !behaviour.nonIdempotentId
          ? existing.id
          : behaviour.nonIdempotentId
            ? `sub_${++mintedIds}_${hashKey(effectiveKey)}`
            : hashKey(effectiveKey);
      subscriptions.set(effectiveKey, { id });

      // Clamp rather than reject, and never hand back no-expiry unasked.
      const cap = 7 * 24 * 3600_000;
      let refreshBefore: unknown;
      if (behaviour.refreshBefore !== undefined) {
        refreshBefore = behaviour.refreshBefore;
      } else if (behaviour.nullRefreshAlways) {
        refreshBefore = null;
      } else if (ttl === null) {
        refreshBefore = null;
      } else if (ttl === undefined) {
        refreshBefore = behaviour.nullRefreshOnOmitted
          ? null
          : new Date(Date.now() + 3600_000).toISOString();
      } else {
        const granted = behaviour.grantBeyondSuggestion
          ? Number(ttl) + 7 * 24 * 3600_000
          : Math.min(Number(ttl), cap);
        refreshBefore = new Date(Date.now() + granted).toISOString();
      }
      const held = subscriptions.get(effectiveKey);
      if (held) {
        held.noExpiry = refreshBefore === null;
        held.at = held.at ?? Date.now();
      }

      if (opts.delivery?.synchronousVerification && typeof url === 'string') {
        const echoed = await challengeCallback(url, delivery.secret, id);
        if (!echoed && !opts.delivery.ignoreFailedEcho) {
          fail(-32015, 'endpoint verification failed', {
            reason: 'challenge_failed'
          });
          return;
        }
      }

      send({
        ...(behaviour.omitId ? {} : { id }),
        refreshBefore,
        cursor: 'cursor_sub_001',
        truncated: false,
        ...(behaviour.result ?? {})
      });

      // Delivery runs after the response, because that is the order a receiver
      // sees it in: the subscribe returns, then the callback starts ringing.
      if (opts.delivery && typeof url === 'string') {
        const run = deliverToCallback(
          url,
          delivery.secret,
          id,
          String(name),
          opts.delivery.synchronousVerification
            ? { ...opts.delivery, verify: false }
            : opts.delivery
        ).finally(() => inFlight.delete(run));
        inFlight.add(run);
      }
      return;
    }

    if (method === 'events/stream') {
      streams.push(params);
      const behaviour = { ...CONFORMANT_STREAM, ...(opts.stream ?? {}) };
      const name = params.name;

      if (behaviour.error) {
        fail(behaviour.error.code, behaviour.error.message);
        return;
      }
      if (
        !behaviour.acceptAnyName &&
        (typeof name !== 'string' || !names.has(name))
      ) {
        fail(opts.unknownNameCode ?? -32011, 'NotFound', { kind: 'event' });
        return;
      }
      if (liveStreams >= behaviour.maxConcurrent) {
        fail(-32013, 'ResourceExhausted: too many subscriptions');
        return;
      }
      if (behaviour.answerJson) {
        send({});
        return;
      }

      liveStreams += 1;
      const entry = openStream(res, id, String(name), behaviour);
      openStreams.add(entry);
      const done = () => {
        if (!openStreams.delete(entry)) return;
        liveStreams -= 1;
        entry.stop();
      };
      req.on('close', done);
      res.on('close', done);
      return;
    }

    fail(-32601, `Method not found: ${method}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    url: `http://localhost:${addr.port}/mcp`,
    polls,
    streams,
    subscribes,
    liveSubscriptions: () => [...subscriptions.keys()],
    async close() {
      // Let the callback stop ringing before the receiver goes away, so a
      // pending fetch cannot outlive the test that started it.
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
      for (const entry of [...openStreams]) {
        openStreams.delete(entry);
        entry.stop();
        entry.res.destroy();
      }
      liveStreams = 0;
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
}

/** Write the SSE frames a push subscription produces, on timers. */
function openStream(
  res: ServerResponse,
  requestId: unknown,
  name: string,
  behaviour: StreamBehaviour & typeof CONFORMANT_STREAM
): { res: ServerResponse; stop: () => void } {
  const timers: NodeJS.Timeout[] = [];
  const stop = () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  /** The correlation id goes where the behaviour says, not always in `_meta`. */
  const correlate = (params: Record<string, unknown>) => {
    if (behaviour.correlation === 'meta') {
      return { ...params, _meta: { [SUBSCRIPTION_ID_META]: requestId } };
    }
    if (behaviour.correlation === 'requestId') {
      return { ...params, requestId };
    }
    return params;
  };
  const notify = (method: string, params: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(
      `data: ${JSON.stringify({ jsonrpc: '2.0', method, params: correlate(params) })}\n\n`
    );
  };
  const after = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
  };

  if (!behaviour.omitActive) {
    notify('notifications/events/active', {
      cursor: 'cursor_stream_001',
      truncated: false,
      ...(behaviour.activeParams ?? {})
    });
  }

  if (behaviour.heartbeatMs > 0) {
    const beat = setInterval(() => {
      notify('notifications/events/heartbeat', {
        cursor: 'cursor_stream_001',
        ...(behaviour.heartbeatParams ?? {})
      });
      if (behaviour.sseComments && !res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, behaviour.heartbeatMs);
    timers.push(beat);
  } else if (behaviour.sseComments) {
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 150);
    timers.push(beat);
  }

  if (behaviour.eventAfterMs > 0) {
    after(behaviour.eventAfterMs, () =>
      notify('notifications/events/event', {
        ...occurrence({ name }),
        ...(behaviour.eventParams ?? {})
      })
    );
  }

  if (behaviour.foreignNotification) {
    after(60, () => notify(behaviour.foreignNotification!, {}));
  }
  if (behaviour.errorNotificationAfterMs) {
    after(behaviour.errorNotificationAfterMs, () =>
      notify('notifications/events/error', {
        code: -32603,
        message: 'upstream unavailable, retrying'
      })
    );
  }
  if (behaviour.terminatedAfterMs) {
    after(behaviour.terminatedAfterMs, () =>
      notify('notifications/events/terminated', { reason: 'revoked' })
    );
  }
  if (behaviour.gapAfterMs) {
    after(behaviour.gapAfterMs, () =>
      notify('notifications/events/active', {
        cursor: 'cursor_stream_002',
        truncated: true
      })
    );
  }
  if (behaviour.closeAfterMs) {
    after(behaviour.closeAfterMs, () => {
      if (res.writableEnded) return;
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          result: behaviour.finalResult ?? { _meta: {} }
        })}\n\n`
      );
      stop();
      res.end();
    });
  }

  return { res, stop };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Retry spacing. Over a second, because `webhook-timestamp` is in seconds and
 * two attempts inside one second would share a stamp the fixture did freshen. */
const RETRY_GAP_MS = 1100;

/**
 * The handshake as a server that verifies inside `events/subscribe` runs it:
 * one signed `verification` POST, and true only for a 2xx whose body echoes the
 * nonce. No retries and no redirects, the same as a delivery.
 */
async function challengeCallback(
  url: string,
  secret: unknown,
  subscriptionId: string
): Promise<boolean> {
  const key =
    typeof secret === 'string' && secret.startsWith('whsec_')
      ? Buffer.from(secret.slice('whsec_'.length), 'base64')
      : Buffer.from(String(secret ?? ''));
  const challenge = `chal_${Math.random().toString(36).slice(2, 14)}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  const webhookId = `msg_verification_${Math.random().toString(36).slice(2, 10)}`;
  const stamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac('sha256', key).update(`${webhookId}.${stamp}.${body}`).digest('base64')}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': stamp,
        'webhook-signature': signature,
        'x-mcp-subscription-id': subscriptionId
      },
      body,
      redirect: 'manual'
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) return false;
    const reply: unknown = JSON.parse(text);
    return isRecord(reply) && reply.challenge === challenge;
  } catch {
    return false;
  }
}

/**
 * POST the verification challenge and then the event, the way the document says
 * to, with whatever this behaviour breaks.
 *
 * Errors are swallowed: the callback is a receiver the scenario owns, it may
 * refuse or vanish mid-run by design, and a fixture that threw here would fail
 * the test rather than the check under test.
 */
async function deliverToCallback(
  url: string,
  secret: unknown,
  subscriptionId: string,
  eventName: string,
  behaviour: DeliveryBehaviour
): Promise<void> {
  const key =
    typeof secret === 'string' && secret.startsWith('whsec_')
      ? behaviour.literalKeySignature
        ? Buffer.from(secret)
        : Buffer.from(secret.slice('whsec_'.length), 'base64')
      : Buffer.from(String(secret ?? ''));

  const headersFor = (webhookId: string, timestamp: string, body: string) => {
    const omit = new Set(behaviour.omitHeaders ?? []);
    const signature = `v1,${createHmac('sha256', key).update(`${webhookId}.${timestamp}.${body}`).digest('base64')}`;
    const headers: Record<string, string> = {
      'content-type': behaviour.contentType ?? 'application/json'
    };
    if (!omit.has('webhook-id')) headers['webhook-id'] = webhookId;
    if (!omit.has('webhook-timestamp'))
      headers['webhook-timestamp'] = timestamp;
    if (!omit.has('webhook-signature'))
      headers['webhook-signature'] = signature;
    if (!behaviour.omitSubscriptionIdHeader) {
      headers['x-mcp-subscription-id'] = behaviour.wrongSubscriptionIdHeader
        ? 'sub_someone_elses'
        : subscriptionId;
    }
    return headers;
  };

  /** One delivery, with the retry rules applied to whatever it answers. */
  const post = async (
    webhookId: string,
    body: string,
    opts: { retryable?: boolean } = {}
  ): Promise<void> => {
    const attempts = Math.max(1, behaviour.attempts ?? 3);
    let stamp = String(Math.floor(Date.now() / 1000));
    let target = url;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && !behaviour.staleRetrySignature) {
        stamp = String(Math.floor(Date.now() / 1000));
      }
      let status: number;
      let location: string | null = null;
      try {
        const res = await fetch(target, {
          method: behaviour.method ?? 'POST',
          headers: headersFor(webhookId, stamp, body),
          body,
          redirect: 'manual'
        });
        status = res.status;
        location = res.headers.get('location');
        await res.text();
      } catch {
        return;
      }

      if (status === 302 && location) {
        // A conformant server stops here. Following is the SSRF hazard the
        // no-redirects rule exists for.
        if (!behaviour.followRedirects) return;
        target = location;
        continue;
      }
      if (status >= 200 && status < 300) return;
      if ((status === 410 || status === 413) && !behaviour.retryNonRetryable) {
        return;
      }
      if (opts.retryable === false) return;
      if (attempt === attempts) return;
      await new Promise((resolve) =>
        setTimeout(resolve, behaviour.retryGapMs ?? RETRY_GAP_MS)
      );
    }
  };

  const envelopeId = (type: string) =>
    behaviour.envelopeIdFormat === 'plain'
      ? `wh-${Math.random().toString(36).slice(2, 10)}`
      : `msg_${type}_${Math.random().toString(36).slice(2, 10)}`;

  /** Control envelopes are signed and headed exactly like deliveries — unless
   * this behaviour is the one that says otherwise. */
  const postEnvelope = async (
    type: string,
    body: Record<string, unknown>
  ): Promise<void> => {
    const json = JSON.stringify({ type, ...body });
    if (behaviour.signEnvelopes === false) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
          redirect: 'manual'
        }).then((r) => r.text());
      } catch {
        // See above: a receiver refusing is the scenario's business.
      }
      return;
    }
    await post(envelopeId(type), json);
  };

  const postEvent = async (): Promise<void> => {
    const data = behaviour.oversizedBody
      ? { id: 'x', padding: 'p'.repeat(300 * 1024) }
      : { id: 'x' };
    await post(
      envelopeId('event'),
      JSON.stringify({
        eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
        name: eventName,
        timestamp: new Date().toISOString(),
        data
      })
    );
  };

  if (behaviour.eventBeforeVerification) {
    await postEvent();
    // The check compares millisecond arrival times, and two loopback POSTs land
    // inside the same millisecond often enough to make the out-of-order case
    // read as in-order. A real server delivering before it verifies is not this
    // close, so the gap is realism rather than a thumb on the scale.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (behaviour.verify !== false) {
    await postEnvelope('verification', {
      challenge: `chal_${Math.random().toString(36).slice(2, 14)}`,
      subscriptionId
    });
  }
  if (behaviour.sendEvent !== false && !behaviour.eventBeforeVerification) {
    await postEvent();
  }
  if (behaviour.gapEnvelope) {
    const override = isRecord(behaviour.gapEnvelope)
      ? behaviour.gapEnvelope
      : {};
    await postEnvelope('gap', {
      cursor: 'cursor_after_gap',
      ...override
    });
  }
  if (behaviour.terminatedEnvelope) {
    const override = isRecord(behaviour.terminatedEnvelope)
      ? behaviour.terminatedEnvelope
      : {};
    await postEnvelope('terminated', {
      error: { code: -32012, message: 'authorization revoked' },
      ...override
    });
  }
}

/** A deterministic id over the subscription key, which is what the document asks for. */
function hashKey(key: string): string {
  return `sub_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}
