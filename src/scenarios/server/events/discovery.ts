/**
 * MCP Events — capability declaration, `events/list`, and the error-code
 * contract.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec excerpt lives next to its check ID in
 * src/seps/sep-3415.yaml, keeping the yaml and this scenario in lock-step.
 *
 * This is the gate scenario for the suite: the delivery-mode scenarios all
 * start from a descriptor found here, so a server that fails `events/list`
 * fails everything downstream for a reason this scenario names.
 *
 * Discovery is dynamic and brand-neutral. The scenario enumerates whatever the
 * server serves and validates the descriptors it finds, hardcoding no event
 * name. An empty catalog is permitted by the document, so descriptor-level
 * checks report the unmet prerequisite via `untestableCheck` rather than
 * passing vacuously.
 *
 * The capability gate is two-sided rather than a plain SKIP. An optional
 * capability a server never declared is not a defect, so a server that also
 * does not implement `events/list` skips the whole scenario. A server that
 * answers `events/list` while declaring nothing is a different thing: it has
 * an events surface that a client following the spec would never call, and
 * SKIP would report that as a clean run. So the scenario asks before it
 * skips.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import { openEventStream } from './stream';
import {
  EVENTS_CONTROL_CATALOG,
  EVENTS_LIST_CHANGED_FILTER_KEY,
  EVENTS_LIST_CHANGED_NOTIFICATION,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
  SUBSCRIPTIONS_LISTEN_METHOD,
  askControl,
  hasControl,
  EVENTS_EXTENSION_ID,
  EVENTS_LIST_METHOD,
  EVENTS_POLL_METHOD,
  EVENTS_SPEC_REF,
  EVENTS_NOT_FOUND,
  EVENTS_UNSUPPORTED,
  DELIVERY_MODES,
  JSONRPC_METHOD_NOT_FOUND,
  type EventDescriptor,
  declaredEventsCapability,
  eventsCapability,
  eventsCheck,
  eventsListPage,
  eventsListAll,
  eventsPoll,
  deliveryModes,
  descriptorName,
  descriptorLabel,
  describeValue,
  isObject,
  isEventsErrorCode,
  resultTypeCheck,
  RESULT_TYPE_ID,
  unknownEventName,
  guardScenario
} from './helpers';
import {
  MCP_NAME_LIST_EXEMPT_ID,
  mcpNameListExemptCheck
} from './routing-headers';

const CAPABILITY_IDS = [
  'sep-3415-capability-events-object',
  'sep-3415-capability-list-changed-flag',
  'sep-3415-capability-empty-settings'
] as const;

const LIST_IDS = [
  'sep-3415-list-implemented',
  'sep-3415-list-pagination'
] as const;

const DESCRIPTOR_IDS = [
  'sep-3415-descriptor-name',
  'sep-3415-descriptor-delivery-subset',
  'sep-3415-descriptor-input-schema',
  'sep-3415-descriptor-payload-schema',
  'sep-3415-descriptor-meta'
] as const;

const ERROR_IDS = [
  'sep-3415-error-not-found',
  'sep-3415-error-server-range',
  'sep-3415-fallback-method-not-found'
] as const;

const LISTEN_IDS = [
  'sep-3415-capability-list-changed-gated',
  'sep-3415-list-changed-notification'
] as const;

const GATED_DESCRIPTION =
  'A server that did not declare `listChanged: true` omits `eventsListChanged` from the acknowledged filter.';
const LIST_CHANGED_DESCRIPTION =
  'A change to the set of event types sends `notifications/events/list_changed`, on a `subscriptions/listen` stream whose client opted in with `eventsListChanged`.';

/** How long to wait for the acknowledgement, and for the notification. */
const LISTEN_ACK_MS = 3000;
const LIST_CHANGED_MS = 3000;

const FALLBACK_DESCRIPTION =
  'A server that does not offer the extension answers any `events/*` request with `-32601 MethodNotFound` (standard JSON-RPC).';

const ALL_IDS = [
  ...CAPABILITY_IDS,
  ...LIST_IDS,
  ...DESCRIPTOR_IDS,
  ...ERROR_IDS,
  ...LISTEN_IDS,
  MCP_NAME_LIST_EXEMPT_ID,
  RESULT_TYPE_ID
];

/** Every check this scenario can emit, as SKIPPED with one shared reason. */
function skipAll(reason: string): ConformanceCheck[] {
  return ALL_IDS.map((id) =>
    eventsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
  );
}

export class EventsDiscoveryScenario implements ClientScenario {
  name = 'events-discovery';
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;
  description = `MCP Events: capability declaration, \`events/list\` enumeration, and the error-code contract.

**Methods**: \`events/list\` (mandatory for a server declaring the extension), \`events/poll\` (probed only for its error path)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-3415.yaml):

- \`sep-3415-capability-events-object\` — \`events\` is declared top-level under \`capabilities\` as an object
- \`sep-3415-capability-list-changed-flag\` — \`listChanged\`, when present, is a boolean
- \`sep-3415-list-implemented\` — \`events/list\` is implemented and returns an \`events\` array
- \`sep-3415-list-pagination\` — \`nextCursor\` is honoured as a cursor on the next request
- \`sep-3415-descriptor-*\` — the descriptor fields: \`name\`, \`description\`, \`delivery\` as a non-empty subset of poll/push/webhook, \`inputSchema\`, \`payloadSchema\`, and \`_meta\` when present
- \`sep-3415-error-not-found\` — an unknown event name answers \`-32023 NotFound\` (the poll-specific restatement of the same rule is graded by \`events-poll\`)
- \`sep-3415-error-server-range\` — the code is one of the five SEP-3415 allocates (\`-32023\` to \`-32027\`), not the design sketch's \`-32011\` to \`-32015\`
- \`sep-3415-result-type-complete\` — the \`events/list\` result carries \`resultType: "complete"\`
- \`sep-3415-capability-list-changed-gated\` — a server that did not declare \`listChanged: true\` leaves \`eventsListChanged\` out of the \`subscriptions/listen\` acknowledgement
- \`sep-3415-list-changed-notification\` — a catalog change, made through the \`events_conformance_catalog\` control, sends \`notifications/events/list_changed\` on an opted-in listen stream
- \`sep-3415-mcp-name-list-exempt\` — an \`events/list\` sent without \`Mcp-Name\` is not refused for lacking one (2026-07-28 only)

**Discovery is dynamic**: a server that neither declares the extension nor implements \`events/list\` SKIPs everything. One that answers \`events/list\` without declaring the extension is graded, and fails the declaration check, because that surface is unreachable for a client that reads capabilities first. An empty catalog reports the descriptor checks as untestable rather than passing them.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    return guardScenario(ALL_IDS, () => this.runUnguarded(ctx));
  }

  private async runUnguarded(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      const checks = await this.checks(conn);
      // The skip path already carries the listen rows as SKIPPED; every other
      // path grades them here, so no row vanishes depending on the server.
      if (
        !checks.some((c) => (LISTEN_IDS as readonly string[]).includes(c.id))
      ) {
        checks.push(...(await this.listenChecks(ctx, conn)));
      }
      if (!checks.some((c) => c.id === MCP_NAME_LIST_EXEMPT_ID)) {
        checks.push(await mcpNameListExemptCheck(ctx));
      }
      return checks;
    } finally {
      await conn.close();
    }
  }

  /**
   * `list_changed` reaches a client only on a `subscriptions/listen` stream it
   * opened with `eventsListChanged: true`, and the server's acknowledgement
   * says whether it will honor that. Two rows hang off one stream:
   *
   * - the gate: a server that did not declare `listChanged: true` must leave
   *   the key out of the acknowledgement. A server that did declare it may
   *   still decline, so for it this row has nothing to grade;
   * - the notification: a server that declared `listChanged: true` sends
   *   `notifications/events/list_changed` when its catalog changes. The
   *   harness cannot change a catalog over the protocol, so it asks the
   *   fixture's `events_conformance_catalog` control to add a type, waits for
   *   the notification, then removes the type again.
   */
  private async listenChecks(
    ctx: RunContext,
    conn: Awaited<ReturnType<RunContext['connect']>>
  ): Promise<ConformanceCheck[]> {
    const caps = await eventsCapability(conn);
    const declaredTrue = caps?.listChanged === true;

    const session = await openEventStream(
      ctx.serverUrl,
      ctx.specVersion,
      { notifications: { [EVENTS_LIST_CHANGED_FILTER_KEY]: true } },
      { method: SUBSCRIPTIONS_LISTEN_METHOD, openTimeoutMs: LISTEN_ACK_MS }
    );
    try {
      const ack = session.contentType?.includes('text/event-stream')
        ? await session.waitFor(
            (n) => n.method === SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
            LISTEN_ACK_MS
          )
        : undefined;
      if (!ack) {
        const why = session.error
          ? `\`${SUBSCRIPTIONS_LISTEN_METHOD}\` failed: ${session.error.code} ${session.error.message}`
          : `\`${SUBSCRIPTIONS_LISTEN_METHOD}\` did not confirm with \`${SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION}\` within ${LISTEN_ACK_MS}ms (HTTP ${session.status}, ${session.contentType ?? 'no content type'})`;
        return [
          declaredTrue
            ? this.gatedNotApplicable()
            : untestableCheck(
                LISTEN_IDS[0],
                LISTEN_IDS[0],
                GATED_DESCRIPTION,
                why,
                [EVENTS_SPEC_REF],
                'FAILURE'
              ),
          declaredTrue
            ? untestableCheck(
                LISTEN_IDS[1],
                LISTEN_IDS[1],
                LIST_CHANGED_DESCRIPTION,
                why,
                [EVENTS_SPEC_REF],
                'FAILURE'
              )
            : this.notificationNotApplicable()
        ];
      }

      const honored = isObject(ack.params.notifications)
        ? ack.params.notifications
        : {};
      const echoed = honored[EVENTS_LIST_CHANGED_FILTER_KEY] === true;
      const checks: ConformanceCheck[] = [];

      if (declaredTrue) {
        checks.push(this.gatedNotApplicable());
      } else {
        checks.push(
          eventsCheck(
            LISTEN_IDS[0],
            GATED_DESCRIPTION,
            echoed ? 'FAILURE' : 'SUCCESS',
            echoed
              ? {
                  errorMessage: `The server declared \`listChanged: ${String(caps?.listChanged ?? false)}\` but acknowledged \`${EVENTS_LIST_CHANGED_FILTER_KEY}\`, promising a notification it did not advertise.`,
                  details: { listChanged: caps?.listChanged, honored }
                }
              : { details: { listChanged: caps?.listChanged, honored } }
          )
        );
      }

      if (!declaredTrue) {
        checks.push(this.notificationNotApplicable());
        return checks;
      }
      if (!echoed) {
        checks.push(
          eventsCheck(LISTEN_IDS[1], LIST_CHANGED_DESCRIPTION, 'FAILURE', {
            errorMessage: `The server declared \`listChanged: true\` but did not honor \`${EVENTS_LIST_CHANGED_FILTER_KEY}\` on \`${SUBSCRIPTIONS_LISTEN_METHOD}\`, which is the only channel the notification travels on, so no client can receive it.`,
            details: { honored }
          })
        );
        return checks;
      }
      if (!(await hasControl(conn, EVENTS_CONTROL_CATALOG))) {
        checks.push(
          untestableCheck(
            LISTEN_IDS[1],
            LISTEN_IDS[1],
            LIST_CHANGED_DESCRIPTION,
            `The server exposes no \`${EVENTS_CONTROL_CATALOG}\` control, and the harness has no other way to change its catalog mid-run.`,
            [EVENTS_SPEC_REF],
            'FAILURE'
          )
        );
        return checks;
      }

      const before = session.notifications.length;
      const added = await askControl(conn, EVENTS_CONTROL_CATALOG, {
        op: 'add'
      });
      const name = added?.match(/^ok:\s*(\S+)/)?.[1];
      if (!name) {
        checks.push(
          untestableCheck(
            LISTEN_IDS[1],
            LISTEN_IDS[1],
            LIST_CHANGED_DESCRIPTION,
            `\`${EVENTS_CONTROL_CATALOG}\` {op: "add"} did not add a type (answered ${JSON.stringify(added)}).`,
            [EVENTS_SPEC_REF],
            'FAILURE'
          )
        );
        return checks;
      }
      const hit = await session.waitFor(
        (n) =>
          n.method === EVENTS_LIST_CHANGED_NOTIFICATION &&
          session.notifications.indexOf(n) >= before,
        LIST_CHANGED_MS
      );
      checks.push(
        eventsCheck(
          LISTEN_IDS[1],
          LIST_CHANGED_DESCRIPTION,
          hit ? 'SUCCESS' : 'FAILURE',
          hit
            ? { details: { added: name, atMs: hit.atMs } }
            : {
                errorMessage: `Added event type \`${name}\` through \`${EVENTS_CONTROL_CATALOG}\`, and no \`${EVENTS_LIST_CHANGED_NOTIFICATION}\` arrived on the acknowledged listen stream within ${LIST_CHANGED_MS}ms.`,
                details: { added: name }
              }
        )
      );
      await askControl(conn, EVENTS_CONTROL_CATALOG, { op: 'remove', name });
      return checks;
    } finally {
      await session.cancel();
    }
  }

  private gatedNotApplicable(): ConformanceCheck {
    return eventsCheck(LISTEN_IDS[0], GATED_DESCRIPTION, 'SKIPPED', {
      errorMessage:
        'The server declared `listChanged: true`; the rule covers servers that did not, and a declaring server may echo or decline the key.'
    });
  }

  private notificationNotApplicable(): ConformanceCheck {
    return eventsCheck(LISTEN_IDS[1], LIST_CHANGED_DESCRIPTION, 'SKIPPED', {
      errorMessage:
        'The server did not declare `listChanged: true`, so it does not promise the notification.'
    });
  }

  private async checks(
    conn: Awaited<ReturnType<RunContext['connect']>>
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    // --- Capability ------------------------------------------------------
    const capDescription =
      "Events is declared through Extension Negotiation: the identifier appears as a key in the `extensions` field of capabilities, mapped to the extension's settings object.";
    const { declared, value } = await declaredEventsCapability(conn);
    /** Set only when the server declared nothing, which is the one case the
     * fallback rule applies to. */
    let undeclaredProbe: Awaited<ReturnType<typeof eventsListPage>> | undefined;

    if (!declared) {
      // An undeclared optional capability is normally a SKIP. It is not one
      // when the server answers `events/list` anyway: that server has an
      // events surface no spec-following client can discover, and SKIP would
      // report it as a clean run. Distinguish the two by asking.
      const probe = await eventsListPage(conn);
      if ('error' in probe && probe.error.code === JSONRPC_METHOD_NOT_FOUND) {
        // Not an events server, so every rule about events is inapplicable —
        // except the one that says what such a server answers, which it just
        // did. Grading it here is the only place the suite ever meets a server
        // that does not offer the extension.
        const skipped = skipAll(
          'Server does not declare the `events` capability and does not implement `events/list`; the extension is optional.'
        ).filter((c) => c.id !== 'sep-3415-fallback-method-not-found');
        return [
          ...skipped,
          eventsCheck(
            'sep-3415-fallback-method-not-found',
            FALLBACK_DESCRIPTION,
            'SUCCESS',
            { details: { code: probe.error.code } }
          )
        ];
      }
      undeclaredProbe = probe;
      checks.push(
        eventsCheck(
          'sep-3415-capability-events-object',
          capDescription,
          'FAILURE',
          {
            errorMessage: `Server answers \`${EVENTS_LIST_METHOD}\` but declares no \`capabilities.extensions["${EVENTS_EXTENSION_ID}"]\`. A client that follows the spec reads capabilities to decide whether to call it, so this surface is unreachable.`,
            details: { extensionId: EVENTS_EXTENSION_ID, declared: false }
          }
        )
      );
    } else if (isObject(value)) {
      checks.push(
        eventsCheck(
          'sep-3415-capability-events-object',
          capDescription,
          'SUCCESS'
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-3415-capability-events-object',
          capDescription,
          'FAILURE',
          {
            errorMessage: `\`capabilities.extensions["${EVENTS_EXTENSION_ID}"]\` is ${describeValue(value)}, expected an object.`,
            details: { declared: value }
          }
        )
      );
    }

    const caps = declared ? await eventsCapability(conn) : undefined;
    const listChanged = caps?.listChanged;
    if (listChanged === undefined) {
      checks.push(
        eventsCheck(
          'sep-3415-capability-list-changed-flag',
          'The `listChanged` flag advertises that the server sends `notifications/events/list_changed`.',
          'SKIPPED',
          {
            errorMessage: declared
              ? 'Server did not declare `listChanged`; the flag is optional and its absence means the notification is not advertised.'
              : 'Server declared no settings object for the flag to sit in; see sep-3415-capability-events-object.'
          }
        )
      );
    } else if (typeof listChanged === 'boolean') {
      checks.push(
        eventsCheck(
          'sep-3415-capability-list-changed-flag',
          'The `listChanged` flag advertises that the server sends `notifications/events/list_changed`.',
          'SUCCESS',
          { details: { listChanged } }
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-3415-capability-list-changed-flag',
          'The `listChanged` flag advertises that the server sends `notifications/events/list_changed`.',
          'FAILURE',
          {
            errorMessage: `\`listChanged\` in the extension's settings object is ${describeValue(listChanged)}, expected a boolean.`,
            details: { listChanged }
          }
        )
      );
    }

    checks.push(this.emptySettingsCheck(declared, value));
    checks.push(this.fallbackCheck(undeclaredProbe));

    // --- events/list -----------------------------------------------------
    const firstPage = await eventsListPage(conn);
    if ('error' in firstPage) {
      const err = firstPage.error;
      const unimplemented = err.code === JSONRPC_METHOD_NOT_FOUND;
      checks.push(
        eventsCheck(
          'sep-3415-list-implemented',
          '`events/list` returns `{events: [...], nextCursor}`, where each entry describes one event type.',
          'FAILURE',
          {
            errorMessage: unimplemented
              ? `Server declares \`capabilities.extensions["${EVENTS_EXTENSION_ID}"]\` but \`${EVENTS_LIST_METHOD}\` is not implemented (-32601).`
              : `\`${EVENTS_LIST_METHOD}\` failed: ${err.code} ${err.message}`,
            details: { code: err.code, message: err.message, data: err.data }
          }
        )
      );
      // Nothing downstream can be graded without a catalog.
      const reason = `\`${EVENTS_LIST_METHOD}\` did not return a result (${err.code} ${err.message}).`;
      for (const id of [...LIST_IDS.slice(1), ...DESCRIPTOR_IDS]) {
        checks.push(
          untestableCheck(id, id, id, reason, [EVENTS_SPEC_REF], 'FAILURE')
        );
      }
      checks.push(resultTypeCheck([]));
      checks.push(...(await this.errorChecks(conn, [])));
      return checks;
    }

    const eventsField = firstPage.result.events;
    if (Array.isArray(eventsField)) {
      checks.push(
        eventsCheck(
          'sep-3415-list-implemented',
          '`events/list` returns `{events: [...], nextCursor}`, where each entry describes one event type.',
          'SUCCESS',
          { details: { firstPageCount: firstPage.descriptors.length } }
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-3415-list-implemented',
          '`events/list` returns `{events: [...], nextCursor}`, where each entry describes one event type.',
          'FAILURE',
          {
            errorMessage: `\`${EVENTS_LIST_METHOD}\` result \`events\` is ${describeValue(eventsField)}, expected an array.`,
            details: { events: eventsField }
          }
        )
      );
    }

    checks.push(
      resultTypeCheck([
        { method: EVENTS_LIST_METHOD, result: firstPage.result }
      ])
    );
    checks.push(await this.paginationCheck(conn, firstPage.result.nextCursor));

    const all = await eventsListAll(conn);
    const descriptors =
      'error' in all ? firstPage.descriptors : all.descriptors;
    checks.push(...this.descriptorChecks(descriptors));
    checks.push(...(await this.errorChecks(conn, descriptors)));

    return checks;
  }

  /**
   * `nextCursor` is only gradeable when the server actually paginates. A
   * single-page catalog leaves nothing to follow, which is a missing
   * prerequisite rather than a pass: the document defers the semantics to the
   * base protocol, so the only thing this check can establish is that
   * `events/list` participates in the scheme at all.
   */
  /**
   * What a server that does not serve events answers to an `events/*` request.
   *
   * Only reachable on a server that declares nothing, since one that offers the
   * extension has no business answering `-32601`. The skip path above grades the
   * clean case; this one grades a server that answered something else, which
   * leaves a client unable to tell "no such extension" from a real failure.
   */
  private fallbackCheck(
    probe: Awaited<ReturnType<typeof eventsListPage>> | undefined
  ): ConformanceCheck {
    const id = 'sep-3415-fallback-method-not-found';
    if (!probe) {
      return eventsCheck(id, FALLBACK_DESCRIPTION, 'SKIPPED', {
        errorMessage:
          'The server declares the extension, so it is not a server that does not offer it and the fallback does not apply. Only a server declaring nothing can answer this rule.'
      });
    }
    if (!('error' in probe)) {
      return eventsCheck(id, FALLBACK_DESCRIPTION, 'SKIPPED', {
        errorMessage: `\`${EVENTS_LIST_METHOD}\` returned a catalog, so this server does offer the extension and the fallback does not apply to it.`
      });
    }
    return eventsCheck(id, FALLBACK_DESCRIPTION, 'FAILURE', {
      errorMessage: `A server declaring no events capability answered \`${EVENTS_LIST_METHOD}\` with ${probe.error.code} ${probe.error.message}, where a server that does not offer the extension answers ${JSONRPC_METHOD_NOT_FOUND} MethodNotFound.`,
      details: { code: probe.error.code }
    });
  }

  /**
   * `{}` as the settings object: support declared, no list-change notifications.
   *
   * Inapplicable rather than failed when the server declared settings of its
   * own, because the rule describes what an empty object means and says nothing
   * about a populated one.
   */
  private emptySettingsCheck(
    declared: boolean,
    value: unknown
  ): ConformanceCheck {
    const id = 'sep-3415-capability-empty-settings';
    const description =
      'An empty settings object declares event support with no list-change notifications.';
    if (!declared || !isObject(value)) {
      return eventsCheck(id, description, 'SKIPPED', {
        errorMessage:
          'No settings object was declared, so there is no empty-object case to grade; see sep-3415-capability-events-object.'
      });
    }
    const keys = Object.keys(value);
    if (keys.length > 0) {
      return eventsCheck(id, description, 'SKIPPED', {
        errorMessage: `The server declared settings (${keys.join(', ')}), so the empty-object case does not apply to it.`
      });
    }
    return eventsCheck(id, description, 'SUCCESS', {
      details: {
        note: 'Empty settings, and the catalog is still served; sep-3415-list-implemented grades that half.'
      }
    });
  }

  private async paginationCheck(
    conn: Awaited<ReturnType<RunContext['connect']>>,
    nextCursor: unknown
  ): Promise<ConformanceCheck> {
    const id = 'sep-3415-list-pagination';
    const description =
      '`nextCursor` is present when more pages are available; same semantics as tools/list.';

    if (nextCursor === undefined || nextCursor === null) {
      return untestableCheck(
        id,
        id,
        description,
        `Server returned a single page from \`${EVENTS_LIST_METHOD}\` with no \`nextCursor\`, so cursor round-tripping could not be exercised.`,
        [EVENTS_SPEC_REF],
        'WARNING'
      );
    }

    if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage: `\`nextCursor\` is ${describeValue(nextCursor)}, expected a non-empty string.`,
        details: { nextCursor }
      });
    }

    const second = await eventsListPage(conn, nextCursor);
    if ('error' in second) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage: `Server returned \`nextCursor\` but rejected it on the next \`${EVENTS_LIST_METHOD}\`: ${second.error.code} ${second.error.message}`,
        details: { nextCursor, code: second.error.code }
      });
    }

    if (second.result.nextCursor === nextCursor) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage:
          'Server echoed the same `nextCursor` on the following page, which never terminates.',
        details: { nextCursor }
      });
    }

    return eventsCheck(id, description, 'SUCCESS', {
      details: { secondPageCount: second.descriptors.length }
    });
  }

  /**
   * Grade every descriptor and report one check per field, naming the first
   * offender. One check per field rather than per descriptor keeps the check
   * IDs stable across servers with different catalog sizes.
   */
  private descriptorChecks(descriptors: EventDescriptor[]): ConformanceCheck[] {
    if (descriptors.length === 0) {
      const reason = `Server's \`${EVENTS_LIST_METHOD}\` returned an empty catalog, so no descriptor could be validated.`;
      return DESCRIPTOR_IDS.map((id) =>
        untestableCheck(id, id, id, reason, [EVENTS_SPEC_REF], 'FAILURE')
      );
    }

    const out: ConformanceCheck[] = [];

    const field = (
      id: string,
      description: string,
      severity: 'FAILURE' | 'WARNING',
      predicate: (d: EventDescriptor) => string | undefined
    ) => {
      for (const [i, d] of descriptors.entries()) {
        const problem = predicate(d);
        if (problem) {
          out.push(
            eventsCheck(id, description, severity, {
              errorMessage: `${descriptorLabel(d, i)}: ${problem}`,
              details: { descriptor: d }
            })
          );
          return;
        }
      }
      out.push(
        eventsCheck(id, description, 'SUCCESS', {
          details: { descriptorsChecked: descriptors.length }
        })
      );
    };

    field(
      'sep-3415-descriptor-name',
      'Each event descriptor carries a `name` identifying the event type.',
      'FAILURE',
      (d) =>
        descriptorName(d) === undefined
          ? `\`name\` is ${describeValue(d.name)}, expected a non-empty string.`
          : undefined
    );

    field(
      'sep-3415-descriptor-delivery-subset',
      '`delivery` lists the delivery modes this event type supports — any non-empty subset of `poll`, `push`, `webhook`.',
      'FAILURE',
      (d) => {
        if (!Array.isArray(d.delivery)) {
          return `\`delivery\` is ${describeValue(d.delivery)}, expected an array.`;
        }
        const modes = deliveryModes(d);
        if (modes.length === 0)
          return '`delivery` is empty; the subset must be non-empty.';
        const unknown = modes.filter(
          (m) => !(DELIVERY_MODES as readonly string[]).includes(m)
        );
        if (unknown.length > 0) {
          return `\`delivery\` contains ${unknown.map((m) => `\`${m}\``).join(', ')}, outside the poll/push/webhook set.`;
        }
        if (new Set(modes).size !== modes.length) {
          return '`delivery` repeats a mode; it is a subset, not a list.';
        }
        return undefined;
      }
    );

    field(
      'sep-3415-descriptor-input-schema',
      '`inputSchema` is a JSON Schema describing valid subscription arguments.',
      'FAILURE',
      (d) =>
        isObject(d.inputSchema)
          ? undefined
          : `\`inputSchema\` is ${describeValue(d.inputSchema)}, expected a JSON Schema object.`
    );

    field(
      'sep-3415-descriptor-payload-schema',
      '`payloadSchema` describes the shape of `data` in delivered events.',
      'FAILURE',
      (d) =>
        isObject(d.payloadSchema)
          ? undefined
          : `\`payloadSchema\` is ${describeValue(d.payloadSchema)}, expected a JSON Schema object.`
    );

    field(
      'sep-3415-descriptor-meta',
      '`_meta` on an event descriptor is optional; same semantics as on Tool/Resource/Prompt.',
      'WARNING',
      (d) =>
        d._meta === undefined || isObject(d._meta)
          ? undefined
          : `\`_meta\` is ${describeValue(d._meta)}, expected an object when present.`
    );

    return out;
  }

  /**
   * Probe the unknown-name error path through `events/poll`.
   *
   * Poll is the cheapest probe: it holds no server-side state, so a rejected
   * call leaves nothing behind. The document states the same obligation twice,
   * once as the general `-32023 NotFound` code and once as the poll-specific
   * consequence of an event type having been removed, so both rows are graded
   * from this one exchange rather than by poking the server twice.
   */
  private async errorChecks(
    conn: Awaited<ReturnType<RunContext['connect']>>,
    descriptors: EventDescriptor[]
  ): Promise<ConformanceCheck[]> {
    const notFoundDesc =
      '`-32023 NotFound` — a referenced entity does not exist, such as an unknown event name.';
    const rangeDesc =
      'The core specification partitions the JSON-RPC implementation-defined range: `-32000` to `-32019` is left to implementations, and `-32020` to `-32099` is allocated sequentially by the specification. This SEP requests the next five codes in the allocated range.';

    // A server offering no poll-capable event type may legitimately not route
    // events/poll at all, which would make -32601 the honest answer and this
    // probe meaningless.
    const pollable = descriptors.some((d) => deliveryModes(d).includes('poll'));
    if (descriptors.length > 0 && !pollable) {
      const reason = `No event type advertises \`poll\` delivery, so \`${EVENTS_POLL_METHOD}\` could not be used to probe the unknown-name error path.`;
      return [
        untestableCheck(
          'sep-3415-error-not-found',
          'sep-3415-error-not-found',
          notFoundDesc,
          reason,
          [EVENTS_SPEC_REF],
          'FAILURE'
        ),
        untestableCheck(
          'sep-3415-error-server-range',
          'sep-3415-error-server-range',
          rangeDesc,
          reason,
          [EVENTS_SPEC_REF],
          'FAILURE'
        )
      ];
    }

    const name = unknownEventName();
    const probe = await eventsPoll(conn, { name, arguments: {}, cursor: null });

    if (!('error' in probe)) {
      const errorMessage = `\`${EVENTS_POLL_METHOD}\` for unknown event name \`${name}\` returned a result instead of an error.`;
      return [
        eventsCheck('sep-3415-error-not-found', notFoundDesc, 'FAILURE', {
          errorMessage,
          details: { result: probe.result }
        }),
        eventsCheck('sep-3415-error-server-range', rangeDesc, 'FAILURE', {
          errorMessage
        })
      ];
    }

    const { code, message, data } = probe.error;
    const isNotFound = code === EVENTS_NOT_FOUND;
    const details = { code, message, data, probedName: name };

    const out: ConformanceCheck[] = [];

    out.push(
      isNotFound
        ? eventsCheck('sep-3415-error-not-found', notFoundDesc, 'SUCCESS', {
            details
          })
        : eventsCheck('sep-3415-error-not-found', notFoundDesc, 'FAILURE', {
            errorMessage: `Unknown event name answered ${code}, expected ${EVENTS_NOT_FOUND} NotFound.${
              code === EVENTS_UNSUPPORTED
                ? ' `-32026 Unsupported` is for a well-formed request naming an option the server does not offer, not for a name it does not have.'
                : ''
            }`,
            details
          })
    );

    out.push(
      isEventsErrorCode(code)
        ? eventsCheck('sep-3415-error-server-range', rangeDesc, 'SUCCESS', {
            details
          })
        : eventsCheck('sep-3415-error-server-range', rangeDesc, 'FAILURE', {
            errorMessage:
              code <= -32000 && code >= -32019
                ? `Error code ${code} sits in \`-32000\` to \`-32019\`, which the specification leaves to implementations. SEP-3415 allocates \`-32023\` to \`-32027\`; \`-32011\` to \`-32015\` are the design sketch's numbers.`
                : `Error code ${code} is not one of the five codes SEP-3415 allocates (\`-32023\` to \`-32027\`).`,
            details
          })
    );

    return out;
  }
}

/** Exported for the negative tests, which assert the full emitted set. */
export const EVENTS_DISCOVERY_CHECK_IDS = ALL_IDS;
