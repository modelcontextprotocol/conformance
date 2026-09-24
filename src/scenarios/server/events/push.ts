/**
 * MCP Events: push delivery over a long-lived `events/stream` request.
 *
 * Scored against the merged design sketch on `main` of
 * modelcontextprotocol/experimental-ext-triggers-events. Each check's verbatim
 * excerpt lives beside its id in src/seps/sep-9999.yaml, where 9999 is a
 * placeholder SEP number.
 *
 * Two things shape what this scenario can grade.
 *
 * The heartbeat is a MUST with a SHOULD of "at least every 30 seconds", so a
 * conformant server may say nothing for 30s. The observation window therefore
 * has to outlast that, which is why the default is 35s and why the scenario
 * needs `--timeout 60000` rather than the runner's 30s default. A shorter
 * window would report a compliant slow-heartbeat server as broken, which is
 * worse than taking the time.
 *
 * Several rows need a server doing something no protocol request can ask for:
 * an upstream failure (`stream-error-is-recoverable`), a retention gap
 * (`stream-gap-resends-active`), a termination (`stream-terminated-*`), or a
 * server-initiated close (`stream-final-result-*`).
 *
 * A fixture MAY expose diagnostic controls as ordinary tools, and this scenario
 * calls the two that are safe to fire mid-stream: neither ends the
 * subscription, so the rows below still see the heartbeats and deliveries they
 * grade. Termination is not fired, because it is terminal for the source and
 * these scenarios share one fixture process, so terminating here would poison
 * whatever runs next.
 *
 * A server with no controls is unaffected and keeps reporting untestable with
 * the missing prerequisite named, per src/scenarios/untestable.ts, rather than
 * passing vacuously against a server that simply never did it.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  EVENTS_ACTIVE_NOTIFICATION,
  EVENTS_EXTENSION_ID,
  EVENTS_CONTROL_YIELD_ERROR,
  EVENTS_CONTROL_YIELD_GAP,
  EVENTS_CONTROL_TERMINATE,
  deliveryModes,
  type EventDescriptor,
  hasControl,
  fireControl,
  extensionsOf,
  EVENTS_ERROR_NOTIFICATION,
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_HEARTBEAT_NOTIFICATION,
  EVENTS_SPEC_REF,
  EVENTS_STREAM_METHOD,
  EVENTS_TERMINATED_NOTIFICATION,
  EVENTS_NOT_FOUND,
  JSONRPC_METHOD_NOT_FOUND,
  SUBSCRIPTION_ID_META,
  describeValue,
  descriptorName,
  eventsCheck,
  eventsListAll,
  firstSupporting,
  isIso8601,
  isObject,
  isValidCursor,
  minimalArguments
} from './helpers';
import { openEventStream, type StreamSession } from './stream';

/** How long to watch an idle stream. Must outlast the document's 30s SHOULD. */
const WATCH_MS = Number(process.env.EVENTS_PUSH_WATCH_MS ?? 35000);

/** How long to wait for the subscription confirmation before grading it. */
const ACTIVE_MS = 3000;
// How long to wait for the terminated frame after firing the control. Generous
// against ACTIVE_MS because the control travels on its own connection and the
// fanout is asynchronous.
const TERMINATE_MS = 5000;

/** Slack on the 30s heartbeat SHOULD, for scheduling and network jitter. */
const HEARTBEAT_TOLERANCE_MS = 2000;

const STREAM_IDS = [
  'sep-9999-stream-implemented',
  'sep-9999-stream-error-before-open',
  'sep-9999-stream-active-confirmation',
  'sep-9999-stream-subscription-id-meta',
  'sep-9999-stream-event-notification',
  'sep-9999-stream-error-is-recoverable',
  'sep-9999-stream-terminated-ends-subscription',
  'sep-9999-stream-gap-resends-active',
  'sep-9999-stream-heartbeat-required',
  'sep-9999-stream-heartbeat-carries-cursor',
  'sep-9999-stream-heartbeat-interval',
  'sep-9999-stream-heartbeat-not-sse-comment',
  'sep-9999-stream-final-result-shape',
  'sep-9999-stream-final-result-timing',
  'sep-9999-stream-cancel-stops-delivery',
  'sep-9999-stream-exempt-from-concurrency-cap',
  'sep-9999-stream-carries-only-event-notifications'
] as const;

function untestableAll(
  ids: readonly string[],
  reason: string,
  severity: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck[] {
  return ids.map((id) =>
    untestableCheck(id, id, id, reason, [EVENTS_SPEC_REF], severity)
  );
}

function skipAll(reason: string): ConformanceCheck[] {
  return STREAM_IDS.map((id) =>
    eventsCheck(id, id, 'SKIPPED', { errorMessage: reason })
  );
}

export class EventsPushScenario implements ClientScenario {
  name = 'events-push';
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;
  description = `MCP Events: push delivery over a long-lived \`events/stream\` request.

**Methods**: \`events/stream\`, plus \`events/list\` to discover an event type advertising \`push\` delivery

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-9999.yaml):

- \`sep-9999-stream-implemented\` / \`sep-9999-stream-error-before-open\` — a valid subscription opens a stream; an invalid one answers a JSON-RPC error and opens nothing
- \`sep-9999-stream-active-confirmation\` / \`sep-9999-stream-subscription-id-meta\` — the \`notifications/events/active\` confirmation, and the parent request id echoed on every notification
- \`sep-9999-stream-event-notification\` / \`sep-9999-stream-carries-only-event-notifications\` — events arrive as \`notifications/events/event\`, and nothing else rides the stream
- \`sep-9999-stream-heartbeat-*\` — the keepalive is required, carries a cursor, arrives at least every 30s, and is a \`data:\` frame rather than an SSE comment
- \`sep-9999-stream-exempt-from-concurrency-cap\` — concurrent streams stay open together
- \`sep-9999-stream-cancel-stops-delivery\` / \`sep-9999-stream-final-result-*\` — cancellation and the empty final result

**This scenario needs \`--timeout 60000\`.** It watches an idle stream for ${WATCH_MS / 1000}s, because a server may heartbeat as slowly as every 30s and still be conformant. Override the window with \`EVENTS_PUSH_WATCH_MS\`.

**Untestable rather than green**: an upstream failure, a retention gap, a termination and a server-initiated close cannot be provoked from the client side, so those rows name the missing prerequisite instead of passing against a server that simply never did it.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    let declared = false;
    try {
      const capabilities = await conn.discover();
      const caps = isObject(capabilities.capabilities)
        ? capabilities.capabilities
        : {};
      declared = extensionsOf(caps)[EVENTS_EXTENSION_ID] !== undefined;

      const listed = await eventsListAll(conn);
      if ('error' in listed) {
        if (!declared && listed.error.code === JSONRPC_METHOD_NOT_FOUND) {
          return skipAll(
            'Server does not declare the `events` capability and does not implement `events/list`; the extension is optional.'
          );
        }
        return untestableAll(
          STREAM_IDS,
          `\`events/list\` failed (${listed.error.code} ${listed.error.message}), so no push-capable event type could be discovered. See the events-discovery scenario.`
        );
      }

      const target = firstSupporting(listed.descriptors, 'push');
      const name = target ? descriptorName(target) : undefined;
      if (!target || !name) {
        return untestableAll(
          STREAM_IDS,
          listed.descriptors.length === 0
            ? '`events/list` returned an empty catalog, so no push-capable event type could be exercised.'
            : 'No event type advertises `push` delivery, so `events/stream` could not be exercised. Push is optional per event type.'
        );
      }

      // Probe for the diagnostic controls here, on the connection that is
      // already open. A server without them must pay nothing for the question:
      // doing this later, around the stream, cost two round trips inside the
      // observation window and was enough to miss a termination arriving at
      // 250ms.
      const controls = {
        error: await hasControl(conn, EVENTS_CONTROL_YIELD_ERROR),
        gap: await hasControl(conn, EVENTS_CONTROL_YIELD_GAP),
        terminate: await hasControl(conn, EVENTS_CONTROL_TERMINATE)
      };

      const args = minimalArguments(target);
      if (args === undefined) {
        return untestableAll(
          STREAM_IDS,
          `Event type \`${name}\` declares required \`inputSchema\` properties the harness cannot satisfy from the schema, so no stream could be opened.`
        );
      }

      return await this.streamChecks(
        ctx,
        name,
        args,
        controls,
        listed.descriptors
      );
    } finally {
      await conn.close();
    }
  }

  private async streamChecks(
    ctx: RunContext,
    name: string,
    args: Record<string, unknown>,
    controls: { error: boolean; gap: boolean; terminate: boolean },
    descriptors: EventDescriptor[]
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const session = await openEventStream(
      ctx.serverUrl,
      ctx.specVersion,
      { name, arguments: args, cursor: null },
      { openTimeoutMs: ACTIVE_MS }
    );

    try {
      // --- The stream opened at all ---------------------------------------
      if (!session.contentType?.includes('text/event-stream')) {
        const err = session.error;
        checks.push(
          eventsCheck(
            'sep-9999-stream-implemented',
            'Push delivery uses a long-lived `events/stream` request — one per subscription, a standard JSON-RPC request with an `id`.',
            'FAILURE',
            {
              errorMessage: err
                ? `Event type \`${name}\` advertises \`push\` delivery but \`${EVENTS_STREAM_METHOD}\` answered ${err.code} ${err.message} instead of opening a stream.`
                : `\`${EVENTS_STREAM_METHOD}\` answered HTTP ${session.status} with content-type ${describeValue(session.contentType)}, expected an SSE stream.`,
              details: { status: session.status, error: err }
            }
          )
        );
        checks.push(
          ...untestableAll(
            STREAM_IDS.filter((id) => id !== 'sep-9999-stream-implemented'),
            `No stream was opened for \`${name}\`, so nothing on it could be observed.`
          )
        );
        checks.push(...(await this.errorBeforeOpenChecks(ctx, args)));
        return dedupe(checks);
      }

      checks.push(
        eventsCheck(
          'sep-9999-stream-implemented',
          'Push delivery uses a long-lived `events/stream` request — one per subscription, a standard JSON-RPC request with an `id`.',
          'SUCCESS',
          { details: { name, status: session.status } }
        )
      );

      // --- Confirmation ----------------------------------------------------
      const active = await session.waitFor(
        (n) => n.method === EVENTS_ACTIVE_NOTIFICATION,
        ACTIVE_MS
      );
      checks.push(this.activeCheck(active, session));

      // --- Provoke the conditions a healthy server never produces ----------
      // An upstream failure and a retention gap are both things the protocol
      // gives a client no way to ask for, so against a server with no
      // diagnostic controls these rows watch, see nothing, and report
      // untestable. A fixture that registers the controls gets them graded.
      // Fired inside the observation window so the frames land in this
      // session's notification list alongside everything else.
      //
      // Neither control ends the subscription, which is what makes them safe
      // to fire here: the stream stays open and the rows below still see the
      // heartbeats and deliveries they grade.
      //
      // Fired over their own connection rather than the streaming one, which is
      // also the more faithful simulation: an upstream failure does not arrive
      // as a request from the subscriber watching for it. The signals fan out
      // to every live subscriber of the event type, so they reach this session
      // regardless. A server with no controls opens no connection here.
      if (controls.error || controls.gap) {
        const control = await ctx.connect();
        try {
          if (controls.error) {
            await fireControl(control, EVENTS_CONTROL_YIELD_ERROR, name);
          }
          if (controls.gap) {
            await fireControl(control, EVENTS_CONTROL_YIELD_GAP, name);
          }
        } finally {
          await control.close();
        }
      }

      // --- Watch the stream ------------------------------------------------
      // One window serves every timing row: heartbeats, delivered events, and
      // whatever else the server chooses to put on the stream.
      await session.settle(WATCH_MS);

      checks.push(...this.notificationChecks(session, name, controls));
      checks.push(...this.heartbeatChecks(session));

      // --- Cancellation ------------------------------------------------------
      const beforeCancel = session.notifications.length;
      await session.cancel();
      await sleep(500);
      checks.push(
        session.notifications.length === beforeCancel
          ? eventsCheck(
              'sep-9999-stream-cancel-stops-delivery',
              'On cancellation the server MUST stop delivering events and release any associated resources.',
              'SUCCESS',
              {
                details: {
                  note: 'Aborting the request stream is the Streamable HTTP cancel; no further frames were read.',
                  notifications: beforeCancel
                }
              }
            )
          : eventsCheck(
              'sep-9999-stream-cancel-stops-delivery',
              'On cancellation the server MUST stop delivering events and release any associated resources.',
              'FAILURE',
              {
                errorMessage: `${session.notifications.length - beforeCancel} further notification(s) arrived after the request stream was aborted.`
              }
            )
      );

      // Opportunistic, and pushed first so dedupe keeps it: a server that
      // closed this stream itself has already answered the final-result rows,
      // and does not need the control path to provoke a second close.
      checks.push(...this.finalResultChecks(session, false));

      checks.push(
        ...(await this.terminateChecks(
          ctx,
          descriptors,
          name,
          controls.terminate
        ))
      );
      checks.push(...(await this.concurrencyChecks(ctx, name, args)));
      checks.push(...(await this.errorBeforeOpenChecks(ctx, args)));
      return dedupe(checks);
    } finally {
      await session.cancel();
    }
  }

  /** `notifications/events/active {cursor, truncated, _meta.subscriptionId}`. */
  private activeCheck(
    active: { params: Record<string, unknown> } | undefined,
    session: StreamSession
  ): ConformanceCheck {
    const description =
      'The server confirms the subscription with `notifications/events/active {cursor, truncated, _meta.subscriptionId}`.';
    if (!active) {
      return eventsCheck(
        'sep-9999-stream-active-confirmation',
        description,
        'FAILURE',
        {
          errorMessage: `No \`${EVENTS_ACTIVE_NOTIFICATION}\` arrived within ${ACTIVE_MS}ms of the stream opening.`,
          details: {
            notifications: session.notifications.map((n) => n.method)
          }
        }
      );
    }
    const problems: string[] = [];
    if (!isValidCursor(active.params.cursor)) {
      problems.push(
        `\`cursor\` is ${describeValue(active.params.cursor)}, expected a string or null`
      );
    }
    if (
      active.params.truncated !== undefined &&
      typeof active.params.truncated !== 'boolean'
    ) {
      problems.push(
        `\`truncated\` is ${describeValue(active.params.truncated)}, expected a boolean`
      );
    }
    return problems.length === 0
      ? eventsCheck(
          'sep-9999-stream-active-confirmation',
          description,
          'SUCCESS',
          { details: { params: active.params } }
        )
      : eventsCheck(
          'sep-9999-stream-active-confirmation',
          description,
          'FAILURE',
          {
            errorMessage: problems.join('; '),
            details: { params: active.params }
          }
        );
  }

  /** What rode the stream, and whether every frame was routable. */
  private notificationChecks(
    session: StreamSession,
    name: string,
    controls: { error: boolean; gap: boolean; terminate: boolean }
  ): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const notifications = session.notifications;

    // Every notifications/events/* message carries the parent request id.
    const missingMeta = notifications.filter((n) => {
      const meta = isObject(n.params._meta) ? n.params._meta : {};
      return meta[SUBSCRIPTION_ID_META] !== session.requestId;
    });
    out.push(
      missingMeta.length === 0 && notifications.length > 0
        ? eventsCheck(
            'sep-9999-stream-subscription-id-meta',
            'Every `notifications/events/*` message carries the JSON-RPC `id` of the parent `events/stream` request in `params._meta["io.modelcontextprotocol/subscriptionId"]`.',
            'SUCCESS',
            { details: { checked: notifications.length } }
          )
        : notifications.length === 0
          ? untestableCheck(
              'sep-9999-stream-subscription-id-meta',
              'sep-9999-stream-subscription-id-meta',
              'Every `notifications/events/*` message carries the parent request id in `_meta`.',
              'The stream delivered no notifications, so no message could be checked for the correlation id.',
              [EVENTS_SPEC_REF]
            )
          : eventsCheck(
              'sep-9999-stream-subscription-id-meta',
              'Every `notifications/events/*` message carries the JSON-RPC `id` of the parent `events/stream` request in `params._meta["io.modelcontextprotocol/subscriptionId"]`.',
              'FAILURE',
              {
                errorMessage: `${missingMeta.length} of ${notifications.length} notification(s) did not carry \`${SUBSCRIPTION_ID_META}\` = ${session.requestId}.`,
                details: {
                  offending: missingMeta
                    .slice(0, 3)
                    .map((n) => ({ method: n.method, meta: n.params._meta }))
                }
              }
            )
    );

    // The stream carries only notifications/events/*.
    const foreign = notifications.filter(
      (n) => !n.method.startsWith('notifications/events/')
    );
    out.push(
      foreign.length === 0
        ? eventsCheck(
            'sep-9999-stream-carries-only-event-notifications',
            'The `events/stream` response carries only `notifications/events/*` messages; it is not a general server-to-client channel.',
            'SUCCESS',
            { details: { checked: notifications.length } }
          )
        : eventsCheck(
            'sep-9999-stream-carries-only-event-notifications',
            'The `events/stream` response carries only `notifications/events/*` messages; it is not a general server-to-client channel.',
            'FAILURE',
            {
              errorMessage: `Non-event messages rode the stream: ${[...new Set(foreign.map((n) => n.method))].join(', ')}.`
            }
          )
    );

    // Delivered events.
    const events = notifications.filter(
      (n) => n.method === EVENTS_EVENT_NOTIFICATION
    );
    if (events.length === 0) {
      out.push(
        untestableCheck(
          'sep-9999-stream-event-notification',
          'sep-9999-stream-event-notification',
          'Events are delivered as `notifications/events/event` whose params are an `EventOccurrence`.',
          `No event was delivered for \`${name}\` in ${WATCH_MS}ms. The fixture needs an event type that emits while the stream is open.`,
          [EVENTS_SPEC_REF]
        )
      );
    } else {
      const bad = events.filter((n) => {
        const p = n.params;
        return (
          typeof p.eventId !== 'string' ||
          typeof p.name !== 'string' ||
          !isIso8601(p.timestamp) ||
          !isObject(p.data)
        );
      });
      out.push(
        bad.length === 0
          ? eventsCheck(
              'sep-9999-stream-event-notification',
              'Events are delivered as `notifications/events/event` whose params are an `EventOccurrence`.',
              'SUCCESS',
              { details: { delivered: events.length } }
            )
          : eventsCheck(
              'sep-9999-stream-event-notification',
              'Events are delivered as `notifications/events/event` whose params are an `EventOccurrence`.',
              'FAILURE',
              {
                errorMessage: `${bad.length} of ${events.length} event notification(s) were not a valid EventOccurrence (eventId, name, timestamp and data are required).`,
                details: { first: bad[0]?.params }
              }
            )
      );
    }

    // Rows that need the server to do something the harness cannot ask for.
    const errorNotes = notifications.filter(
      (n) => n.method === EVENTS_ERROR_NOTIFICATION
    );
    out.push(
      errorNotes.length === 0
        ? untestableCheck(
            'sep-9999-stream-error-is-recoverable',
            'sep-9999-stream-error-is-recoverable',
            '`notifications/events/error` reports a recoverable failure; the subscription remains active.',
            controls.error
              ? `The \`${EVENTS_CONTROL_YIELD_ERROR}\` control was called for \`${name}\` but no \`${EVENTS_ERROR_NOTIFICATION}\` arrived, so the recovery path could not be observed.`
              : `No upstream failure occurred during the run, and the harness cannot provoke one over the protocol. Needs a fixture exposing the \`${EVENTS_CONTROL_YIELD_ERROR}\` control.`,
            [EVENTS_SPEC_REF]
          )
        : eventsCheck(
            'sep-9999-stream-error-is-recoverable',
            '`notifications/events/error` reports a recoverable failure; the subscription remains active and the server retries and resumes.',
            session.open ? 'SUCCESS' : 'FAILURE',
            {
              errorMessage: session.open
                ? undefined
                : 'The stream closed after `notifications/events/error`, but only `notifications/events/terminated` ends a subscription.',
              details: { errors: errorNotes.length }
            }
          )
    );

    // A server that terminates on its own during the main window is graded
    // here and the control path below never runs for these ids, since dedupe
    // is first-wins. Nothing is emitted when it does not: terminateChecks owns
    // the untestable branch, because it is the one that knows whether a
    // control existed and whether a spare event type was available.
    const terminated = notifications.filter(
      (n) => n.method === EVENTS_TERMINATED_NOTIFICATION
    );
    if (terminated.length > 0) {
      out.push(
        eventsCheck(
          'sep-9999-stream-terminated-ends-subscription',
          'Only `notifications/events/terminated` ends the subscription.',
          'SUCCESS',
          { details: { terminated: terminated.length } }
        )
      );
    }

    const actives = notifications.filter(
      (n) => n.method === EVENTS_ACTIVE_NOTIFICATION
    );
    const gapActive = actives.slice(1).find((n) => n.params.truncated === true);
    out.push(
      gapActive
        ? eventsCheck(
            'sep-9999-stream-gap-resends-active',
            'A gap is not an error — the server sends a fresh `notifications/events/active {cursor:<fresh>, truncated:true}` and continues delivering.',
            'SUCCESS',
            { details: { params: gapActive.params } }
          )
        : untestableCheck(
            'sep-9999-stream-gap-resends-active',
            'sep-9999-stream-gap-resends-active',
            'A gap is signalled by a fresh `notifications/events/active` with `truncated: true`, not an error.',
            controls.gap
              ? `The \`${EVENTS_CONTROL_YIELD_GAP}\` control was called for \`${name}\` but no second \`active\` carrying \`truncated: true\` arrived.`
              : `No retention gap occurred during the run, and the harness cannot force one from the client side. Needs a fixture exposing the \`${EVENTS_CONTROL_YIELD_GAP}\` control.`,
            [EVENTS_SPEC_REF],
            'WARNING'
          )
    );

    return out;
  }

  /** The four heartbeat rows, all graded off the same watch window. */
  private heartbeatChecks(session: StreamSession): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const beats = session.notifications.filter(
      (n) => n.method === EVENTS_HEARTBEAT_NOTIFICATION
    );

    // A window shorter than the 30s cadence the document allows cannot tell a
    // silent server from a slow one, so it reports the missing prerequisite
    // rather than failing a server that may be conformant.
    const windowCoversCadence = WATCH_MS > 30000;
    out.push(
      beats.length > 0
        ? eventsCheck(
            'sep-9999-stream-heartbeat-required',
            'The server MUST send periodic keepalive messages on the push stream so the client can distinguish "nothing to send" from "connection is dead."',
            'SUCCESS',
            { details: { beats: beats.length, windowMs: WATCH_MS } }
          )
        : windowCoversCadence
          ? eventsCheck(
              'sep-9999-stream-heartbeat-required',
              'The server MUST send periodic keepalive messages on the push stream so the client can distinguish "nothing to send" from "connection is dead."',
              'FAILURE',
              {
                errorMessage: `No \`${EVENTS_HEARTBEAT_NOTIFICATION}\` arrived in ${WATCH_MS}ms, which outlasts the 30s cadence the document asks for.`,
                details: {
                  windowMs: WATCH_MS,
                  sawSseComments: session.sseComments.length
                }
              }
            )
          : untestableCheck(
              'sep-9999-stream-heartbeat-required',
              'sep-9999-stream-heartbeat-required',
              'The server MUST send periodic keepalive messages on the push stream.',
              `No heartbeat arrived, but the watch window was ${WATCH_MS}ms and the document allows a 30s cadence, so a conformant server could look identical. Re-run with EVENTS_PUSH_WATCH_MS above 30000.`,
              [EVENTS_SPEC_REF]
            )
    );

    if (beats.length === 0) {
      out.push(
        ...untestableAll(
          [
            'sep-9999-stream-heartbeat-carries-cursor',
            'sep-9999-stream-heartbeat-interval'
          ],
          `No heartbeat arrived in ${WATCH_MS}ms, so its contents and cadence could not be observed.`
        )
      );
    } else {
      const badCursor = beats.filter((n) => !isValidCursor(n.params.cursor));
      out.push(
        badCursor.length === 0
          ? eventsCheck(
              'sep-9999-stream-heartbeat-carries-cursor',
              'The heartbeat carries `cursor`, the position the server has checked up to; it is `null` for event types that do not support replay.',
              'SUCCESS',
              { details: { beats: beats.length } }
            )
          : eventsCheck(
              'sep-9999-stream-heartbeat-carries-cursor',
              'The heartbeat carries `cursor`, the position the server has checked up to; it is `null` for event types that do not support replay.',
              'FAILURE',
              {
                errorMessage: `${badCursor.length} heartbeat(s) carried a \`cursor\` that was neither a string nor null (first: ${describeValue(badCursor[0]?.params.cursor)}).`
              }
            )
      );

      // The gap the client would see: stream open to first beat, then between
      // beats. A single beat still bounds the wait the client endured.
      const marks = [0, ...beats.map((b) => b.atMs)];
      const gaps = marks.slice(1).map((m, i) => m - marks[i]);
      const worst = Math.max(...gaps);
      // A server that times its heartbeat at exactly 30s lands a few ms over
      // once scheduling and the network have had their say, and reporting that
      // as a missed SHOULD is the harness being pedantic rather than the server
      // being late. kitchen-sink measured 30005ms.
      out.push(
        worst <= 30000 + HEARTBEAT_TOLERANCE_MS
          ? eventsCheck(
              'sep-9999-stream-heartbeat-interval',
              'The server SHOULD send a heartbeat at least every 30 seconds.',
              'SUCCESS',
              { details: { worstGapMs: worst, beats: beats.length } }
            )
          : eventsCheck(
              'sep-9999-stream-heartbeat-interval',
              'The server SHOULD send a heartbeat at least every 30 seconds.',
              'WARNING',
              {
                errorMessage: `Longest silence was ${worst}ms, over the 30s the document asks for (with ${HEARTBEAT_TOLERANCE_MS}ms of tolerance).`,
                details: { gapsMs: gaps }
              }
            )
      );
    }

    out.push(
      session.sseComments.length === 0
        ? eventsCheck(
            'sep-9999-stream-heartbeat-not-sse-comment',
            'On Streamable HTTP the heartbeat is an SSE `data:` frame; the SSE comment form (`: keepalive`) is not used since it cannot carry cursor state.',
            'SUCCESS',
            { details: { comments: 0 } }
          )
        : eventsCheck(
            'sep-9999-stream-heartbeat-not-sse-comment',
            'On Streamable HTTP the heartbeat is an SSE `data:` frame; the SSE comment form (`: keepalive`) is not used since it cannot carry cursor state.',
            beats.length === 0 ? 'FAILURE' : 'WARNING',
            {
              errorMessage: `The stream carried ${session.sseComments.length} SSE comment line(s) (e.g. ${JSON.stringify(session.sseComments[0])}), which cannot carry cursor state.`
            }
          )
    );

    return out;
  }

  /** The `StreamEventsResult`, which only a server-initiated close produces. */
  /**
   * Grade the three rows that need the *server* to end the stream:
   * `stream-terminated-ends-subscription` and both `stream-final-result-*`.
   *
   * These cannot be graded on the main session. The harness cancels that one
   * to test `stream-cancel-stops-delivery`, and on Streamable HTTP a
   * client-side abort is terminal, so no final frame is ever sent. A
   * server-ended stream is a different stream.
   *
   * Termination is one-shot for the event type and the events scenarios share
   * a fixture process, so this deliberately refuses to terminate the type the
   * rest of the run depends on. A fixture with only one push-capable type gets
   * untestable rather than a poisoned suite.
   */
  private async terminateChecks(
    ctx: RunContext,
    descriptors: EventDescriptor[],
    usedName: string,
    hasTerminate: boolean
  ): Promise<ConformanceCheck[]> {
    // Severity follows each row's own keyword, not the reason they share.
    // Terminating is a MUST; the final-result shape and timing are SHOULDs, and
    // flattening all three to FAILURE overstates two of them.
    const untestableHere = (reason: string): ConformanceCheck[] => [
      ...untestableAll(
        ['sep-9999-stream-terminated-ends-subscription'],
        reason
      ),
      ...untestableAll(
        [
          'sep-9999-stream-final-result-shape',
          'sep-9999-stream-final-result-timing'
        ],
        reason,
        'WARNING'
      )
    ];

    if (!hasTerminate) {
      return untestableHere(
        `The subscription was not terminated during the run, and the harness cannot revoke one over the protocol. Needs a fixture exposing the \`${EVENTS_CONTROL_TERMINATE}\` control.`
      );
    }

    const spare = descriptors
      .filter((d) => deliveryModes(d).includes('push'))
      .map((d) => descriptorName(d))
      .find((n): n is string => !!n && n !== usedName);
    if (!spare) {
      return untestableHere(
        `Terminating an event type is one-shot for the life of the fixture, and \`${usedName}\` is the only push-capable type on offer, so terminating it would break every scenario after this one. Needs a second push-capable type the run does not otherwise depend on.`
      );
    }

    const args = minimalArguments(
      descriptors.find((d) => descriptorName(d) === spare)!
    );
    if (args === undefined) {
      return untestableHere(
        `Event type \`${spare}\` declares required \`inputSchema\` properties the harness cannot satisfy, so no stream could be opened to terminate.`
      );
    }

    const session = await openEventStream(
      ctx.serverUrl,
      ctx.specVersion,
      { name: spare, arguments: args, cursor: null },
      { openTimeoutMs: ACTIVE_MS }
    );
    try {
      if (!session.contentType?.includes('text/event-stream')) {
        return untestableHere(
          `\`${EVENTS_STREAM_METHOD}\` did not open a stream for \`${spare}\`, so there was nothing to terminate.`
        );
      }
      await session.waitFor(
        (n) => n.method === EVENTS_ACTIVE_NOTIFICATION,
        ACTIVE_MS
      );

      const control = await ctx.connect();
      try {
        await fireControl(control, EVENTS_CONTROL_TERMINATE, spare);
      } finally {
        await control.close();
      }

      const terminated = await session.waitFor(
        (n) => n.method === EVENTS_TERMINATED_NOTIFICATION,
        TERMINATE_MS
      );
      await session.settle(500);

      const out: ConformanceCheck[] = [];
      out.push(
        terminated
          ? eventsCheck(
              'sep-9999-stream-terminated-ends-subscription',
              'Only `notifications/events/terminated` ends the subscription.',
              session.open ? 'FAILURE' : 'SUCCESS',
              {
                errorMessage: session.open
                  ? `\`${EVENTS_TERMINATED_NOTIFICATION}\` arrived for \`${spare}\` but the stream stayed open.`
                  : undefined,
                details: { name: spare }
              }
            )
          : eventsCheck(
              'sep-9999-stream-terminated-ends-subscription',
              'Only `notifications/events/terminated` ends the subscription.',
              'FAILURE',
              {
                errorMessage: `The \`${EVENTS_CONTROL_TERMINATE}\` control was called for \`${spare}\` but no \`${EVENTS_TERMINATED_NOTIFICATION}\` arrived within ${TERMINATE_MS}ms.`
              }
            )
      );
      out.push(...this.finalResultChecks(session));
      return out;
    } finally {
      await session.cancel();
    }
  }

  private finalResultChecks(
    session: StreamSession,
    emitUntestable = true
  ): ConformanceCheck[] {
    const result = session.finalResult?.result;
    if (result === undefined) {
      // The main session calls this opportunistically: a server that closed
      // the stream itself has answered these rows, and one that did not leaves
      // them to terminateChecks, which knows why they could not be exercised.
      if (!emitUntestable) return [];
      return untestableAll(
        [
          'sep-9999-stream-final-result-shape',
          'sep-9999-stream-final-result-timing'
        ],
        'The server did not close the stream itself, so no final frame was sent.',
        'WARNING'
      );
    }
    const out: ConformanceCheck[] = [];
    // `_meta` and `resultType` are base-protocol fields on the common `Result`
    // interface, not information this extension's final frame carries. Servers
    // MUST include `resultType`, so counting it as a payload field fails every
    // conformant server; mcpkit is how that surfaced.
    const keys = isObject(result)
      ? Object.keys(result).filter((k) => k !== '_meta' && k !== 'resultType')
      : ['<not an object>'];
    out.push(
      keys.length === 0
        ? eventsCheck(
            'sep-9999-stream-final-result-shape',
            'The `StreamEventsResult` is an empty typed result (`{"_meta": {}}`).',
            'SUCCESS',
            { details: { result } }
          )
        : eventsCheck(
            'sep-9999-stream-final-result-shape',
            'The `StreamEventsResult` is an empty typed result (`{"_meta": {}}`).',
            'FAILURE',
            {
              errorMessage: `The final result carried ${keys.join(', ')}; it is defined to carry no information.`,
              details: { result }
            }
          )
    );
    out.push(
      eventsCheck(
        'sep-9999-stream-final-result-timing',
        'The final result is sent whenever the server can write a final frame; on Streamable HTTP only when the server initiates the close.',
        'SUCCESS',
        {
          details: {
            note: 'The server initiated the close and wrote a final frame.'
          }
        }
      )
    );
    return out;
  }

  /** Concurrent streams, which a request-concurrency cap would strangle. */
  private async concurrencyChecks(
    ctx: RunContext,
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const description =
      'Server SDKs MUST exempt `events/stream` from any general request-concurrency cap, since each push subscription is a long-lived request that never completes until cancelled.';
    const sessions: StreamSession[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        sessions.push(
          await openEventStream(
            ctx.serverUrl,
            ctx.specVersion,
            { name, arguments: args, cursor: null },
            { openTimeoutMs: ACTIVE_MS }
          )
        );
      }
      const streamed = sessions.filter((s) =>
        s.contentType?.includes('text/event-stream')
      );
      const confirmed = await Promise.all(
        streamed.map((s) =>
          s.waitFor((n) => n.method === EVENTS_ACTIVE_NOTIFICATION, ACTIVE_MS)
        )
      );
      const live = confirmed.filter(Boolean).length;
      return [
        live === sessions.length
          ? eventsCheck(
              'sep-9999-stream-exempt-from-concurrency-cap',
              description,
              'SUCCESS',
              { details: { concurrent: live } }
            )
          : eventsCheck(
              'sep-9999-stream-exempt-from-concurrency-cap',
              description,
              'FAILURE',
              {
                errorMessage: `Opened ${sessions.length} concurrent \`${EVENTS_STREAM_METHOD}\` requests; only ${live} confirmed with \`${EVENTS_ACTIVE_NOTIFICATION}\`.`,
                details: {
                  statuses: sessions.map((s) => ({
                    status: s.status,
                    contentType: s.contentType,
                    error: s.error
                  }))
                }
              }
            )
      ];
    } finally {
      await Promise.all(sessions.map((s) => s.cancel()));
    }
  }

  /** An invalid subscription answers an error and opens no stream. */
  private async errorBeforeOpenChecks(
    ctx: RunContext,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const unknown = `conformance.nonexistent.${Date.now()}`;
    const session = await openEventStream(
      ctx.serverUrl,
      ctx.specVersion,
      { name: unknown, arguments: args, cursor: null },
      { openTimeoutMs: 1000 }
    );
    try {
      const description =
        'If the subscription is invalid (`NotFound`, `Forbidden`, `InvalidParams`, `Unsupported`), the server responds immediately with a JSON-RPC error and no stream is opened.';
      if (!session.error) {
        return [
          eventsCheck(
            'sep-9999-stream-error-before-open',
            description,
            'FAILURE',
            {
              errorMessage: `\`${EVENTS_STREAM_METHOD}\` for unknown event type \`${unknown}\` did not answer a JSON-RPC error (HTTP ${session.status}, content-type ${describeValue(session.contentType)}).`,
              details: {
                notifications: session.notifications.map((n) => n.method)
              }
            }
          )
        ];
      }
      return [
        session.error.code === EVENTS_NOT_FOUND
          ? eventsCheck(
              'sep-9999-stream-error-before-open',
              description,
              'SUCCESS',
              { details: { code: session.error.code } }
            )
          : eventsCheck(
              'sep-9999-stream-error-before-open',
              description,
              'WARNING',
              {
                errorMessage: `Unknown event type answered ${session.error.code} ${session.error.message}; the document names \`-32011 NotFound\` for a referenced entity that does not exist.`,
                details: { error: session.error }
              }
            )
      ];
    } finally {
      await session.cancel();
    }
  }
}

/** Keep the first check emitted per id, so a fallback path cannot double-report. */
function dedupe(checks: ConformanceCheck[]): ConformanceCheck[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
