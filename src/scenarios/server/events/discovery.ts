/**
 * MCP Events — capability declaration, `events/list`, and the error-code
 * contract.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec excerpt lives next to its check ID in
 * src/seps/sep-9999.yaml, keeping the yaml and this scenario in lock-step.
 * 9999 is a placeholder SEP number; see that file's header.
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
import {
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
  inServerErrorRange,
  unknownEventName
} from './helpers';

const CAPABILITY_IDS = [
  'sep-9999-capability-events-object',
  'sep-9999-capability-list-changed-flag',
  'sep-9999-capability-empty-settings'
] as const;

const LIST_IDS = [
  'sep-9999-list-implemented',
  'sep-9999-list-pagination'
] as const;

const DESCRIPTOR_IDS = [
  'sep-9999-descriptor-name',
  'sep-9999-descriptor-description',
  'sep-9999-descriptor-delivery-subset',
  'sep-9999-descriptor-input-schema',
  'sep-9999-descriptor-payload-schema',
  'sep-9999-descriptor-meta'
] as const;

const ERROR_IDS = [
  'sep-9999-error-not-found',
  'sep-9999-error-server-range',
  'sep-9999-fallback-method-not-found'
] as const;

const FALLBACK_DESCRIPTION =
  'A server that does not offer the extension answers any `events/*` request with `-32601 MethodNotFound` (standard JSON-RPC).';

const ALL_IDS = [
  ...CAPABILITY_IDS,
  ...LIST_IDS,
  ...DESCRIPTOR_IDS,
  ...ERROR_IDS
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

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-9999.yaml):

- \`sep-9999-capability-events-object\` — \`events\` is declared top-level under \`capabilities\` as an object
- \`sep-9999-capability-list-changed-flag\` — \`listChanged\`, when present, is a boolean
- \`sep-9999-list-implemented\` — \`events/list\` is implemented and returns an \`events\` array
- \`sep-9999-list-pagination\` — \`nextCursor\` is honoured as a cursor on the next request
- \`sep-9999-descriptor-*\` — the descriptor fields: \`name\`, \`description\`, \`delivery\` as a non-empty subset of poll/push/webhook, \`inputSchema\`, \`payloadSchema\`, and \`_meta\` when present
- \`sep-9999-error-not-found\` — an unknown event name answers \`-32011 NotFound\` (the poll-specific restatement of the same rule is graded by \`events-poll\`)
- \`sep-9999-error-server-range\` — the extension's codes sit in the JSON-RPC implementation-defined server range

**Discovery is dynamic**: a server that neither declares the extension nor implements \`events/list\` SKIPs everything. One that answers \`events/list\` without declaring the extension is graded, and fails the declaration check, because that surface is unreachable for a client that reads capabilities first. An empty catalog reports the descriptor checks as untestable rather than passing them.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      return await this.checks(conn);
    } finally {
      await conn.close();
    }
  }

  private async checks(
    conn: Awaited<ReturnType<RunContext['connect']>>
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    // --- Capability ------------------------------------------------------
    const capDescription =
      "Events is declared through Extension Negotiation: the identifier appears as a key in the `extensions` field of capabilities, mapped to the extension's settings object.";
    const { declared, value } = await declaredEventsCapability(conn);

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
        ).filter((c) => c.id !== 'sep-9999-fallback-method-not-found');
        return [
          ...skipped,
          eventsCheck(
            'sep-9999-fallback-method-not-found',
            FALLBACK_DESCRIPTION,
            'SUCCESS',
            { details: { code: probe.error.code } }
          )
        ];
      }
      checks.push(this.fallbackCheck(probe));
      checks.push(
        eventsCheck(
          'sep-9999-capability-events-object',
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
          'sep-9999-capability-events-object',
          capDescription,
          'SUCCESS'
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-9999-capability-events-object',
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
          'sep-9999-capability-list-changed-flag',
          'The `listChanged` flag advertises that the server sends `notifications/events/list_changed`.',
          'SKIPPED',
          {
            errorMessage: declared
              ? 'Server did not declare `listChanged`; the flag is optional and its absence means the notification is not advertised.'
              : 'Server declared no settings object for the flag to sit in; see sep-9999-capability-events-object.'
          }
        )
      );
    } else if (typeof listChanged === 'boolean') {
      checks.push(
        eventsCheck(
          'sep-9999-capability-list-changed-flag',
          'The `listChanged` flag advertises that the server sends `notifications/events/list_changed`.',
          'SUCCESS',
          { details: { listChanged } }
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-9999-capability-list-changed-flag',
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

    // --- events/list -----------------------------------------------------
    const firstPage = await eventsListPage(conn);
    if ('error' in firstPage) {
      const err = firstPage.error;
      const unimplemented = err.code === JSONRPC_METHOD_NOT_FOUND;
      checks.push(
        eventsCheck(
          'sep-9999-list-implemented',
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
      checks.push(...(await this.errorChecks(conn, [])));
      return checks;
    }

    const eventsField = firstPage.result.events;
    if (Array.isArray(eventsField)) {
      checks.push(
        eventsCheck(
          'sep-9999-list-implemented',
          '`events/list` returns `{events: [...], nextCursor}`, where each entry describes one event type.',
          'SUCCESS',
          { details: { firstPageCount: firstPage.descriptors.length } }
        )
      );
    } else {
      checks.push(
        eventsCheck(
          'sep-9999-list-implemented',
          '`events/list` returns `{events: [...], nextCursor}`, where each entry describes one event type.',
          'FAILURE',
          {
            errorMessage: `\`${EVENTS_LIST_METHOD}\` result \`events\` is ${describeValue(eventsField)}, expected an array.`,
            details: { events: eventsField }
          }
        )
      );
    }

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
    probe: Awaited<ReturnType<typeof eventsListPage>>
  ): ConformanceCheck {
    const id = 'sep-9999-fallback-method-not-found';
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
    const id = 'sep-9999-capability-empty-settings';
    const description =
      'An empty settings object declares event support with no list-change notifications.';
    if (!declared || !isObject(value)) {
      return eventsCheck(id, description, 'SKIPPED', {
        errorMessage:
          'No settings object was declared, so there is no empty-object case to grade; see sep-9999-capability-events-object.'
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
        note: 'Empty settings, and the catalog is still served; sep-9999-list-implemented grades that half.'
      }
    });
  }

  private async paginationCheck(
    conn: Awaited<ReturnType<RunContext['connect']>>,
    nextCursor: unknown
  ): Promise<ConformanceCheck> {
    const id = 'sep-9999-list-pagination';
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
      'sep-9999-descriptor-name',
      'Each event descriptor carries a `name` identifying the event type.',
      'FAILURE',
      (d) =>
        descriptorName(d) === undefined
          ? `\`name\` is ${describeValue(d.name)}, expected a non-empty string.`
          : undefined
    );

    field(
      'sep-9999-descriptor-description',
      'Each event descriptor carries a `description` of when the event fires.',
      'WARNING',
      (d) =>
        typeof d.description === 'string' && d.description.length > 0
          ? undefined
          : `\`description\` is ${describeValue(d.description)}, expected a non-empty string.`
    );

    field(
      'sep-9999-descriptor-delivery-subset',
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
      'sep-9999-descriptor-input-schema',
      '`inputSchema` is a JSON Schema describing valid subscription arguments.',
      'FAILURE',
      (d) =>
        isObject(d.inputSchema)
          ? undefined
          : `\`inputSchema\` is ${describeValue(d.inputSchema)}, expected a JSON Schema object.`
    );

    field(
      'sep-9999-descriptor-payload-schema',
      '`payloadSchema` describes the shape of `data` in delivered events.',
      'FAILURE',
      (d) =>
        isObject(d.payloadSchema)
          ? undefined
          : `\`payloadSchema\` is ${describeValue(d.payloadSchema)}, expected a JSON Schema object.`
    );

    field(
      'sep-9999-descriptor-meta',
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
   * once as the general `-32011 NotFound` code and once as the poll-specific
   * consequence of an event type having been removed, so both rows are graded
   * from this one exchange rather than by poking the server twice.
   */
  private async errorChecks(
    conn: Awaited<ReturnType<RunContext['connect']>>,
    descriptors: EventDescriptor[]
  ): Promise<ConformanceCheck[]> {
    const notFoundDesc =
      '`-32011 NotFound` — a referenced entity does not exist, such as an unknown event name.';
    const rangeDesc =
      "The extension's codes are carried in the JSON-RPC implementation-defined server range `[-32000, -32099]`.";

    // A server offering no poll-capable event type may legitimately not route
    // events/poll at all, which would make -32601 the honest answer and this
    // probe meaningless.
    const pollable = descriptors.some((d) => deliveryModes(d).includes('poll'));
    if (descriptors.length > 0 && !pollable) {
      const reason = `No event type advertises \`poll\` delivery, so \`${EVENTS_POLL_METHOD}\` could not be used to probe the unknown-name error path.`;
      return [
        untestableCheck(
          'sep-9999-error-not-found',
          'sep-9999-error-not-found',
          notFoundDesc,
          reason,
          [EVENTS_SPEC_REF],
          'FAILURE'
        ),
        untestableCheck(
          'sep-9999-error-server-range',
          'sep-9999-error-server-range',
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
        eventsCheck('sep-9999-error-not-found', notFoundDesc, 'FAILURE', {
          errorMessage,
          details: { result: probe.result }
        }),
        eventsCheck('sep-9999-error-server-range', rangeDesc, 'FAILURE', {
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
        ? eventsCheck('sep-9999-error-not-found', notFoundDesc, 'SUCCESS', {
            details
          })
        : eventsCheck('sep-9999-error-not-found', notFoundDesc, 'FAILURE', {
            errorMessage: `Unknown event name answered ${code}, expected ${EVENTS_NOT_FOUND} NotFound.${
              code === EVENTS_UNSUPPORTED
                ? ' `-32014 Unsupported` is for a well-formed request naming an option the server does not offer, not for a name it does not have.'
                : ''
            }`,
            details
          })
    );

    out.push(
      inServerErrorRange(code)
        ? eventsCheck('sep-9999-error-server-range', rangeDesc, 'SUCCESS', {
            details
          })
        : eventsCheck('sep-9999-error-server-range', rangeDesc, 'FAILURE', {
            errorMessage: `Error code ${code} is outside the implementation-defined server range [-32099, -32000].`,
            details
          })
    );

    return out;
  }
}

/** Exported for the negative tests, which assert the full emitted set. */
export const EVENTS_DISCOVERY_CHECK_IDS = ALL_IDS;
