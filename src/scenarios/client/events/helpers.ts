/**
 * Shared mock server for the Events client scenarios.
 *
 * The harness plays the events server and the client is the system under
 * test. Every scenario serves two event types whose descriptors name a single
 * delivery mode, so a client picks poll, push or webhook from `events/list`
 * the way it would against a real server, and the scenario name only tells a
 * driver which flow to run.
 *
 * Contract for the client under test, keyed on MCP_CONFORMANCE_SCENARIO:
 * connect, read the server's capabilities, and if the Events extension is
 * declared, call `events/list` and subscribe to every listed event type in
 * the mode its descriptor names. Keep the subscriptions running for
 * `context.durationMs` (from MCP_CONFORMANCE_CONTEXT), then stop and exit.
 */

import http from 'http';
import { ConformanceCheck, CheckStatus } from '../../../types.js';
import { BaseHttpScenario } from '../http-base.js';
import {
  EVENTS_EXTENSION_ID,
  EVENTS_LIST_METHOD,
  EVENTS_SPEC_REF,
  eventsCheck
} from '../../server/events/helpers.js';
import { untestableCheck } from '../../untestable.js';

export { EVENTS_EXTENSION_ID, eventsCheck };

/** Replays from a cursor; every position the server hands out is a string. */
export const REPLAY_TYPE = 'conformance.ticks';
/** No addressable history; the server only ever returns `cursor: null`. */
export const CURSORLESS_TYPE = 'conformance.cursorless';

export type DeliveryMode = 'poll' | 'push' | 'webhook';

export interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
  id: unknown;
  at: number;
}

export function descriptor(name: string, mode: DeliveryMode): object {
  return {
    name,
    description:
      name === REPLAY_TYPE
        ? 'A counter that ticks on every poll; replays from a cursor.'
        : 'Has no addressable history, so every cursor is null.',
    delivery: [mode],
    inputSchema: { type: 'object', properties: {} }
  };
}

/** `cursor` from a request, with an absent field read as `null`. */
export function cursorOf(params: Record<string, unknown>): unknown {
  return params.cursor === undefined ? null : params.cursor;
}

export abstract class EventsClientScenarioBase extends BaseHttpScenario {
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;

  /** Every request and notification the client sent, in arrival order. */
  protected requests: RecordedRequest[] = [];

  /** How long the client should keep its subscriptions running. */
  protected abstract durationMs: number;
  protected abstract mode: DeliveryMode;

  /** `undefined` makes the scenario a server that declares no Events support. */
  protected eventsSettings(): object | undefined {
    return {};
  }

  async start(ctx: Parameters<BaseHttpScenario['start']>[0]) {
    this.requests = [];
    const urls = await super.start(ctx);
    return { ...urls, context: { durationMs: this.durationMs } };
  }

  protected discoverCapabilities(): object {
    const settings = this.eventsSettings();
    return settings === undefined
      ? { tools: {} }
      : { tools: {}, extensions: { [EVENTS_EXTENSION_ID]: settings } };
  }

  private record(request: any): void {
    this.requests.push({
      method: request.method,
      params: (request.params ?? {}) as Record<string, unknown>,
      id: request.id,
      at: Date.now()
    });
  }

  /** The base class answers `server/discover` before `handlePost` sees it. */
  protected sendDiscover(res: http.ServerResponse, request: any): void {
    this.record(request);
    super.sendDiscover(res, request);
  }

  protected handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    this.record(request);

    if (request.method === 'initialize') {
      this.sendInitialize(res, request);
      return;
    }
    if (request.id === undefined) {
      this.sendNotificationAck(res);
      return;
    }
    if (request.method === EVENTS_LIST_METHOD) {
      this.sendJson(res, {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          events: [
            descriptor(REPLAY_TYPE, this.mode),
            descriptor(CURSORLESS_TYPE, this.mode)
          ]
        }
      });
      return;
    }
    if (this.handleEvents(req, res, request)) return;
    this.sendGenericResult(res, request);
  }

  /** Serve one `events/*` request; return false to fall through. */
  protected abstract handleEvents(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): boolean;

  protected requestsFor(method: string, name?: string): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === method && (name === undefined || r.params.name === name)
    );
  }

  /** True once the client has reached the server at all. */
  protected clientConnected(): boolean {
    return this.requests.length > 0;
  }

  /** Open an SSE response the caller writes JSON-RPC frames to. */
  protected openSse(res: http.ServerResponse): (message: object) => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'mcp-session-id': this.sessionId
    });
    return (message: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
    };
  }
}

/**
 * A check the client gave the scenario no chance to grade, because it never
 * performed the step the check observes. Severity follows the requirement's
 * keyword, per the untestable policy in src/scenarios/untestable.ts.
 */
export function clientUntestable(
  id: string,
  description: string,
  reason: string,
  severity: 'FAILURE' | 'WARNING'
): ConformanceCheck {
  return untestableCheck(
    id,
    id,
    description,
    reason,
    [EVENTS_SPEC_REF],
    severity
  );
}

export function graded(
  id: string,
  description: string,
  ok: boolean,
  severity: 'FAILURE' | 'WARNING',
  errorMessage: string,
  details?: Record<string, unknown>
): ConformanceCheck {
  const status: CheckStatus = ok ? 'SUCCESS' : severity;
  return eventsCheck(id, description, status, {
    errorMessage: ok ? undefined : errorMessage,
    details
  });
}
