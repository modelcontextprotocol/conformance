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
import { encodeMcpHeaderValue } from '../../../connection/stateless.js';

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
  /** The `Mcp-Name` header as received, when the request carried one. */
  mcpName?: string;
}

/** The `events/*` methods that carry `Mcp-Name`; `events/list` does not. */
const MCP_NAME_METHODS = new Set([
  'events/poll',
  'events/stream',
  'events/subscribe',
  'events/unsubscribe'
]);

const MCP_NAME_SET_ID = 'sep-3415-client-mcp-name-set';
const MCP_NAME_SET_DESC =
  'On Streamable HTTP the client MUST set `Mcp-Name` to `params.name` on `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe`.';
export const MCP_NAME_BASE64_ID = 'sep-3415-client-mcp-name-base64';
const MCP_NAME_BASE64_DESC =
  'An event name that cannot be safely represented as a plain ASCII header value MUST be carried in the Base64 sentinel format.';

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

  private record(request: any, req?: http.IncomingMessage): void {
    const header = req?.headers['mcp-name'];
    this.requests.push({
      method: request.method,
      params: (request.params ?? {}) as Record<string, unknown>,
      id: request.id,
      at: Date.now(),
      mcpName: Array.isArray(header) ? header[0] : header
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
    this.record(request, req);

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
          resultType: 'complete',
          events: [
            descriptor(REPLAY_TYPE, this.mode),
            descriptor(CURSORLESS_TYPE, this.mode),
            ...this.extraDescriptors()
          ]
        }
      });
      return;
    }
    if (this.handleEvents(req, res, request)) return;
    this.sendGenericResult(res, request);
  }

  /** Event types a scenario lists beyond the two every scenario serves. */
  protected extraDescriptors(): object[] {
    return [];
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

  /** True when the client used the 2026-07-28 lifecycle (no `initialize`). */
  protected stateless(): boolean {
    return !this.requests.some((r) => r.method === 'initialize');
  }

  /**
   * Grade `Mcp-Name` on every named `events/*` request whose name is plain
   * ASCII. The routing header is a 2026-07-28 transport rule, so a client on
   * the legacy lifecycle skips.
   */
  protected mcpNameSetCheck(): ConformanceCheck {
    if (!this.stateless()) {
      return eventsCheck(MCP_NAME_SET_ID, MCP_NAME_SET_DESC, 'SKIPPED', {
        errorMessage:
          'The client used the legacy lifecycle; `Mcp-Name` is a 2026-07-28 Streamable HTTP header.'
      });
    }
    const named = this.requests.filter(
      (r) =>
        MCP_NAME_METHODS.has(r.method) &&
        typeof r.params.name === 'string' &&
        encodeMcpHeaderValue(r.params.name) === r.params.name
    );
    if (named.length === 0) {
      return clientUntestable(
        MCP_NAME_SET_ID,
        MCP_NAME_SET_DESC,
        'the client sent no `events/*` request naming an event',
        'FAILURE'
      );
    }
    const wrong = named.filter((r) => r.mcpName !== r.params.name);
    return graded(
      MCP_NAME_SET_ID,
      MCP_NAME_SET_DESC,
      wrong.length === 0,
      'FAILURE',
      `${wrong.length} of ${named.length} named \`events/*\` request(s) did not carry \`Mcp-Name\` equal to \`params.name\`: ${wrong
        .slice(0, 3)
        .map(
          (r) =>
            `\`${r.method}\` for ${JSON.stringify(r.params.name)} sent ${r.mcpName === undefined ? 'no header' : JSON.stringify(r.mcpName)}`
        )
        .join('; ')}.`,
      { requests: named.length }
    );
  }

  /** Grade the Base64 sentinel on the requests naming `name`. */
  protected mcpNameBase64Check(name: string): ConformanceCheck {
    if (!this.stateless()) {
      return eventsCheck(MCP_NAME_BASE64_ID, MCP_NAME_BASE64_DESC, 'SKIPPED', {
        errorMessage:
          'The client used the legacy lifecycle; `Mcp-Name` is a 2026-07-28 Streamable HTTP header.'
      });
    }
    const sent = this.requests.filter(
      (r) => MCP_NAME_METHODS.has(r.method) && r.params.name === name
    );
    if (sent.length === 0) {
      return clientUntestable(
        MCP_NAME_BASE64_ID,
        MCP_NAME_BASE64_DESC,
        `the client sent no \`events/*\` request for ${JSON.stringify(name)}, the listed type whose name is not plain ASCII`,
        'FAILURE'
      );
    }
    const expected = encodeMcpHeaderValue(name);
    const wrong = sent.filter((r) => r.mcpName !== expected);
    return graded(
      MCP_NAME_BASE64_ID,
      MCP_NAME_BASE64_DESC,
      wrong.length === 0,
      'FAILURE',
      `For ${JSON.stringify(name)} the client sent ${wrong[0]?.mcpName === undefined ? 'no `Mcp-Name`' : `\`Mcp-Name: ${wrong[0]?.mcpName}\``}, where SEP-2243's sentinel is \`${expected}\`.`
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
    // Node holds the headers until the first write. A stream that writes
    // nothing for a while (the session GET stream, before list_changed) would
    // then never answer at all, and a client that waits for the response
    // headers before carrying on (mcpkit's Go client opens the GET stream
    // inside Connect) blocks until the run times out.
    res.flushHeaders();
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
