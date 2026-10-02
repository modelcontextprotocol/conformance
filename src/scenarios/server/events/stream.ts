/**
 * A long-lived `events/stream` request, which the `Connection` abstraction
 * cannot express.
 *
 * `conn.request()` resolves when the response for its JSON-RPC id arrives, and
 * that is exactly what a push stream withholds: the `StreamEventsResult` is
 * the last frame before close, so a scenario that awaited it would block for
 * the life of the subscription and see none of the notifications it is meant
 * to grade. `readSseJsonRpcResponse` has the same shape of problem — it stops
 * reading at the first frame matching the request id.
 *
 * So this opens the POST itself, hands back a session while the stream is
 * still open, and appends frames as they arrive. The scenario waits for the
 * frames it needs, grades them, then aborts. Aborting is also what the
 * document calls the client-side cancel on Streamable HTTP, so the cancel
 * checks come out of the same mechanism rather than a second code path.
 *
 * stdio is out of scope here: the runner addresses a URL, and the document's
 * stdio rules (`notifications/cancelled`, the MAY on a final result) have no
 * HTTP analogue. Rows that only bite on stdio are reported untestable by the
 * scenario rather than graded against a transport the harness cannot open.
 */

import {
  buildStandardHeaders,
  withRequestMeta,
  type JsonRpcResponse
} from '../../../connection';
import type { SpecVersion } from '../../../types';
import { isObject } from './helpers';

/** A JSON-RPC notification as it arrived on the stream. */
export interface StreamNotification {
  method: string;
  params: Record<string, unknown>;
  /** Milliseconds since the stream was opened, for the heartbeat interval. */
  atMs: number;
}

export interface StreamSession {
  /** The JSON-RPC id of the `events/stream` request, echoed in `_meta`. */
  readonly requestId: number;
  /** HTTP status of the POST that opened the stream. */
  readonly status: number;
  readonly contentType?: string;
  /** Set when the server answered with an immediate JSON-RPC error. */
  readonly error?: { code: number; message: string; data?: unknown };
  /** Set when a response for `requestId` arrived (the `StreamEventsResult`). */
  readonly finalResult?: JsonRpcResponse;
  /** Notifications in arrival order. */
  readonly notifications: StreamNotification[];
  /** Frames that were neither a notification nor this request's response. */
  readonly foreignFrames: unknown[];
  /** SSE comment lines (`: keepalive`), which the document rules out. */
  readonly sseComments: string[];
  /** Whether the reader is still running. */
  readonly open: boolean;
  /** Resolve once a notification matches, or undefined at the deadline. */
  waitFor(
    predicate: (n: StreamNotification) => boolean,
    timeoutMs: number
  ): Promise<StreamNotification | undefined>;
  /** Resolve after `ms`, or earlier if the stream closes. */
  settle(ms: number): Promise<void>;
  /** Abort the request stream, which is the client-side cancel on HTTP. */
  cancel(): Promise<void>;
}

/** Open `events/stream` and return once the server has answered the POST. */
export async function openEventStream(
  serverUrl: string,
  specVersion: SpecVersion,
  params: Record<string, unknown>,
  options: { openTimeoutMs?: number } = {}
): Promise<StreamSession> {
  const requestId = Math.floor(Math.random() * 1_000_000) + 1;
  const headers = buildStandardHeaders('events/stream', params, {
    specVersion
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'events/stream',
    params: withRequestMeta(params, specVersion)
  });

  const controller = new AbortController();
  const openedAt = Date.now();
  const notifications: StreamNotification[] = [];
  const foreignFrames: unknown[] = [];
  const sseComments: string[] = [];
  const state = {
    open: true,
    error: undefined as StreamSession['error'],
    finalResult: undefined as JsonRpcResponse | undefined
  };

  const res = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal
  });
  const contentType = res.headers.get('content-type') ?? undefined;

  const ingest = (frame: unknown): void => {
    if (!isObject(frame)) {
      foreignFrames.push(frame);
      return;
    }
    if (typeof frame.method === 'string' && frame.id === undefined) {
      notifications.push({
        method: frame.method,
        params: isObject(frame.params) ? frame.params : {},
        atMs: Date.now() - openedAt
      });
      return;
    }
    if (frame.id === requestId) {
      state.finalResult = frame as unknown as JsonRpcResponse;
      if (isObject(frame.error)) {
        state.error = {
          code: Number(frame.error.code),
          message: String(frame.error.message ?? ''),
          data: frame.error.data
        };
      }
      return;
    }
    foreignFrames.push(frame);
  };

  // A JSON body means the server answered rather than streamed: either the
  // immediate error the document requires for an invalid subscription, or a
  // server that does not implement push at all.
  if (!contentType?.includes('text/event-stream')) {
    state.open = false;
    const text = await res.text();
    try {
      ingest(JSON.parse(text));
    } catch {
      foreignFrames.push(text);
    }
  } else {
    void readFrames(res, ingest, sseComments).finally(() => {
      state.open = false;
    });
  }

  const session: StreamSession = {
    requestId,
    status: res.status,
    contentType,
    get error() {
      return state.error;
    },
    get finalResult() {
      return state.finalResult;
    },
    get open() {
      return state.open;
    },
    notifications,
    foreignFrames,
    sseComments,
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = notifications.find(predicate);
        if (hit) return hit;
        if (!state.open || Date.now() >= deadline) {
          return notifications.find(predicate);
        }
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    },
    async settle(ms) {
      const deadline = Date.now() + ms;
      while (state.open && Date.now() < deadline) {
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    },
    async cancel() {
      controller.abort();
      state.open = false;
    }
  };

  // Give a streaming server a moment to write its confirmation frame, so a
  // caller that opens and immediately grades is not racing the first write.
  if (state.open) {
    await session.waitFor(() => true, options.openTimeoutMs ?? 2000);
  }
  return session;
}

/** Read SSE `data:` frames until the stream ends or the request is aborted. */
async function readFrames(
  res: Response,
  ingest: (frame: unknown) => void,
  sseComments: string[]
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(':')) {
          sseComments.push(line);
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          ingest(JSON.parse(payload));
        } catch {
          ingest(payload);
        }
      }
    }
  } catch {
    // Aborted by cancel(), or the connection dropped. Either way the frames
    // that arrived are what the scenario grades.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
