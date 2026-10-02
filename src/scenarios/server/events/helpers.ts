/**
 * Shared helpers for the MCP Events server-conformance scenarios under this
 * directory.
 *
 * Extracted against the merged design sketch on `main` of
 * modelcontextprotocol/experimental-ext-triggers-events (merged 2026-09-08).
 * Each check's verbatim excerpt lives next to its check ID in
 * src/seps/sep-9999.yaml, and 9999 is a placeholder SEP number — see that
 * file's header before renaming anything here.
 *
 * One thing about Events differs from every other extension suite here and is
 * worth knowing before reading the scenarios:
 *
 * 1. No delivery mode is mandatory. A descriptor's `delivery` array is any
 *    non-empty subset of poll/push/webhook, so a scenario for one mode has to
 *    discover whether any event type offers it before it can probe anything.
 *    Nothing is hardcoded to a fixture's event names.
 */

import type {
  CheckStatus,
  ConformanceCheck,
  SpecReference
} from '../../../types';
import type { Connection } from '../../../connection';
import { JsonRpcError } from '../../../connection';

/**
 * The Events extension identifier, per SEP-2133 Extension Negotiation.
 *
 * It does double duty: `ScenarioSource` carries it as `{ extensionId }`, which
 * keeps these scenarios out of `--spec-version` selection (see
 * `matchesSpecVersion` in src/scenarios/index.ts), and it is the key the
 * capability itself lives under in `capabilities.extensions`.
 *
 * Those were two different things until 2026-09-22. The design sketch put the
 * capability at the top level as `capabilities.events`, and this file said in
 * as many words not to read the capability at this key. Upstream PR 7 moved the
 * sketch into the extensions map after mcpkit followed the document and the
 * reference server did not, so the two uses collapsed into one.
 */
export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

export const EVENTS_LIST_METHOD = 'events/list';
export const EVENTS_POLL_METHOD = 'events/poll';
export const EVENTS_STREAM_METHOD = 'events/stream';
export const EVENTS_SUBSCRIBE_METHOD = 'events/subscribe';
export const EVENTS_UNSUBSCRIBE_METHOD = 'events/unsubscribe';

export const EVENTS_LIST_CHANGED_NOTIFICATION =
  'notifications/events/list_changed';
export const EVENTS_EVENT_NOTIFICATION = 'notifications/events/event';
export const EVENTS_ACTIVE_NOTIFICATION = 'notifications/events/active';
export const EVENTS_HEARTBEAT_NOTIFICATION = 'notifications/events/heartbeat';
export const EVENTS_ERROR_NOTIFICATION = 'notifications/events/error';
export const EVENTS_TERMINATED_NOTIFICATION = 'notifications/events/terminated';

/**
 * The `_meta` key carrying the parent `events/stream` request id on every
 * `notifications/events/*` message, per SEP-2575's correlation convention.
 */
export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId';

/** The three delivery modes, as they appear in a descriptor's `delivery`. */
export const DELIVERY_MODES = ['poll', 'push', 'webhook'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Standard JSON-RPC. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

/**
 * The general-purpose codes this document defines, carried in the JSON-RPC
 * implementation-defined server range. Named for reuse across MCP rather than
 * scoped to events, and each conveys its specifics through a typed `data`
 * payload rather than by minting more numbers.
 */
export const EVENTS_NOT_FOUND = -32011;
export const EVENTS_FORBIDDEN = -32012;
export const EVENTS_RESOURCE_EXHAUSTED = -32013;
export const EVENTS_UNSUPPORTED = -32014;
export const EVENTS_CALLBACK_ENDPOINT_ERROR = -32015;

/** Inclusive bounds of the JSON-RPC implementation-defined server range. */
export const SERVER_ERROR_RANGE_MIN = -32099;
export const SERVER_ERROR_RANGE_MAX = -32000;

export const EVENTS_SPEC_REF: SpecReference = {
  id: 'MCP-Events',
  url: 'https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md'
};

/** One entry of the `events` array returned by `events/list`. */
export interface EventDescriptor {
  name?: unknown;
  description?: unknown;
  delivery?: unknown;
  inputSchema?: unknown;
  payloadSchema?: unknown;
  _meta?: unknown;
  [key: string]: unknown;
}

export interface EventsListResult {
  events?: unknown;
  nextCursor?: unknown;
  [key: string]: unknown;
}

/** One entry of a poll response's `events` array, or a pushed notification. */
export interface EventOccurrence {
  eventId?: unknown;
  name?: unknown;
  timestamp?: unknown;
  data?: unknown;
  cursor?: unknown;
  _meta?: unknown;
  [key: string]: unknown;
}

export interface EventsPollResult {
  events?: unknown;
  cursor?: unknown;
  truncated?: unknown;
  hasMore?: unknown;
  nextPollMs?: unknown;
  [key: string]: unknown;
}

/**
 * Build a check carrying the Events spec reference. Per AGENTS.md the same
 * `id` flips `status` + `errorMessage` between SUCCESS and FAILURE rather than
 * branching into distinct slugs.
 */
export function eventsCheck(
  id: string,
  description: string,
  status: CheckStatus,
  extras: Partial<ConformanceCheck> = {}
): ConformanceCheck {
  return {
    id,
    name: id,
    description,
    status,
    timestamp: new Date().toISOString(),
    specReferences: [EVENTS_SPEC_REF],
    ...extras
  };
}

/** A JSON object, as opposed to an array, `null`, or a primitive. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How to name an observed value in an error message.
 *
 * `absent` rather than `a undefined`, because a reader chasing a failure needs
 * to know the field was missing, and the JavaScript spelling of that is noise.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Whether the server declared the events capability at all, and the raw value
 * it declared it with, before any shape coercion.
 *
 * Kept separate from `eventsCapability` so callers can tell "absent" from
 * "declared with the wrong type" apart. Folding the two together would turn a
 * server that declares `events: true` into a clean SKIP of the whole suite,
 * which reads as a green run against a server that is plainly wrong.
 */
export async function declaredEventsCapability(
  conn: Connection
): Promise<{ declared: boolean; value: unknown }> {
  const discovered = await conn.discover();
  const caps = (discovered.capabilities as Record<string, unknown>) ?? {};
  const exts = extensionsOf(caps);
  if (!(EVENTS_EXTENSION_ID in exts))
    return { declared: false, value: undefined };
  return { declared: true, value: exts[EVENTS_EXTENSION_ID] };
}

/**
 * Names of the optional diagnostic controls a fixture may expose so the harness
 * can provoke conditions no protocol request can ask for.
 *
 * Several requirements describe what a server does when something goes wrong
 * upstream, and a healthy server does none of those during a run. Without a way
 * to trigger them the rows report untestable forever. A fixture that wants
 * those rows graded registers these as ordinary tools; one that does not is
 * unaffected and keeps reporting untestable with the prerequisite named.
 *
 * Each control takes `{ name: <event type> }`. mcpkit's
 * examples/events/kitchen-sink registers them under --conformance-events; see
 * that repo's examples/CONVENTIONS.md for the convention.
 */
export const EVENTS_CONTROL_YIELD_ERROR = 'events_conformance_yield_error';
export const EVENTS_CONTROL_YIELD_GAP = 'events_conformance_yield_gap';
/**
 * Ends every live subscription to an event type. Terminal for that type for
 * the life of the fixture process, so a scenario firing it must pick a type
 * nothing else in the run depends on.
 */
export const EVENTS_CONTROL_TERMINATE = 'events_conformance_terminate';
/**
 * Registers a subscription on another principal's behalf, returning its derived
 * id. A run authenticates as one principal for its lifetime, so this is the
 * only way to construct the two-tenant case the key-composition rule is about.
 */
export const EVENTS_CONTROL_SUBSCRIBE_AS = 'events_conformance_subscribe_as';
/**
 * Permits callbacks under one origin past the scheme and routability guards for
 * the rest of the fixture process, so the harness can be delivered to.
 *
 * The harness necessarily listens on loopback, and a hardened server refuses a
 * loopback callback — correctly, which is what the SSRF rows grade. Those two
 * facts cannot both hold in one subscription, so without this the delivery rows
 * are unreachable unless EVENTS_WEBHOOK_CALLBACK_BASE points at a public tunnel.
 *
 * Takes `{ origin }` and names one origin, not a blanket "allow private
 * networks": the fixture stays hardened for every other callback, which is what
 * lets the SSRF rows be graded first and then the delivery rows after. mcpkit's
 * `--conformance-events` build already allowlists one origin this way for the
 * events-webhook scenario, which is spec path (b) doing the same job.
 */
export const EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN =
  'events_conformance_allow_callback_origin';

/**
 * Reports one per-event-type subscription cap the server enforces, as JSON text
 * `{"name": "<event type>", "max": <n>}`. Read-only.
 *
 * `-32013` is only reachable by exceeding a limit, and nothing in the protocol
 * says where a server's limits are. The concurrency probe cannot find one for
 * the suite: it opens three streams on one type and needs all three to stay
 * open, so a server capped there fails the MUST beside it. Knowing the capped
 * type lets the quota be probed on its own.
 */
export const EVENTS_CONTROL_QUOTA = 'events_conformance_quota';

/**
 * Send a `{type:"gap"}` envelope to one webhook subscription, `{ id }`,
 * answering the cursor it carried. Per subscription rather than per event type
 * because a source's gap signal reaches push streams, and a webhook subscriber
 * hears of one only when the server posts to it.
 */
export const EVENTS_CONTROL_WEBHOOK_GAP = 'events_conformance_webhook_gap';

/**
 * End one webhook subscription, `{ id }`, sending it `{type:"terminated"}`.
 * Per subscription so the scenario ends only its own, where terminating an
 * event type would end it for every scenario after.
 */
export const EVENTS_CONTROL_WEBHOOK_TERMINATE =
  'events_conformance_webhook_terminate';

/** Reports whether a given principal's subscription is still registered. */
export const EVENTS_CONTROL_SUBSCRIPTION_EXISTS =
  'events_conformance_subscription_exists';
/**
 * Rebuilds the server and its subscription registry over the same store, as a
 * process restart would. Every session ends, so a scenario firing it must
 * reconnect and must fire it last.
 */
export const EVENTS_CONTROL_RESTART = 'events_conformance_restart';
/**
 * Answers the fixture's current restart generation. The restart control
 * answers the generation it is moving to, so a scenario can tell the restart
 * happened whether the server keeps sessions (the old one dies) or is
 * stateless (the same connection starts reaching the new build).
 */
export const EVENTS_CONTROL_GENERATION = 'events_conformance_generation';
/**
 * Takes `{ id }`, a derived subscription id, and answers `active`,
 * `suspended` or `absent`. Unlike the exists control it sees a subscription
 * the server has suspended after delivery failures, which is what separates
 * "paused" from "dropped".
 */
export const EVENTS_CONTROL_SUBSCRIPTION_STATE =
  'events_conformance_subscription_state';

/**
 * Fire a control that answers with text, returning the text or undefined.
 * Distinct from fireControl, which only cares that the call succeeded.
 */
export async function askControl(
  conn: Connection,
  tool: string,
  args: Record<string, unknown>
): Promise<string | undefined> {
  try {
    const res = await conn.request<{
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    }>('tools/call', { name: tool, arguments: args });
    if (res.isError) return undefined;
    const text = (res.content ?? []).find((c) => c?.type === 'text')?.text;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the server exposes a given diagnostic control.
 *
 * Absence is the normal case and never an error: the caller falls back to
 * reporting untestable with the missing prerequisite named, per
 * src/scenarios/untestable.ts.
 */
export async function hasControl(
  conn: Connection,
  tool: string
): Promise<boolean> {
  try {
    const res = await conn.request<{ tools?: { name?: string }[] }>(
      'tools/list'
    );
    return (res.tools ?? []).some((t) => t?.name === tool);
  } catch {
    return false;
  }
}

/**
 * Fire a diagnostic control, returning whether it ran. A server that lists the
 * tool but rejects the call is treated as not having it, so a half-implemented
 * control reports untestable rather than failing the requirement it was meant
 * to exercise.
 */
export async function fireControl(
  conn: Connection,
  tool: string,
  name: string
): Promise<boolean> {
  try {
    await conn.request('tools/call', { name: tool, arguments: { name } });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `extensions` map from a capabilities object, or an empty map.
 *
 * Every scenario that probes the declaration goes through this rather than
 * indexing `capabilities` directly, so the one place that knows where the
 * capability lives is this file.
 */
export function extensionsOf(
  caps: Record<string, unknown>
): Record<string, unknown> {
  return (caps.extensions as Record<string, unknown>) ?? {};
}

/**
 * The events capability object, or `undefined` when the server did not declare
 * it — or declared it with something that is not an object, which callers
 * treat the same way. An undeclared optional capability is a SKIP.
 */
export async function eventsCapability(
  conn: Connection
): Promise<Record<string, unknown> | undefined> {
  const { value } = await declaredEventsCapability(conn);
  return isObject(value) ? value : undefined;
}

/** A single `events/list` page, kept separate so pagination can be inspected. */
export interface EventsListPage {
  result: EventsListResult;
  descriptors: EventDescriptor[];
}

/**
 * Call `events/list` once, optionally with a cursor. Returns the `JsonRpcError`
 * rather than throwing, so a scenario can grade the error instead of aborting.
 */
export async function eventsListPage(
  conn: Connection,
  cursor?: string
): Promise<EventsListPage | { error: JsonRpcError }> {
  try {
    const result = await conn.request<EventsListResult>(
      EVENTS_LIST_METHOD,
      cursor ? { cursor } : undefined
    );
    const raw = result?.events;
    return {
      result: result ?? {},
      descriptors: Array.isArray(raw) ? (raw as EventDescriptor[]) : []
    };
  } catch (err) {
    if (err instanceof JsonRpcError) return { error: err };
    throw err;
  }
}

/**
 * Every descriptor from `events/list`, paginating until `nextCursor` clears.
 *
 * Bounded at `maxPages` because a server that echoes the same `nextCursor`
 * forever would otherwise hang the scenario rather than fail it. Hitting the
 * bound is reported through `truncatedByBound` so the caller can say so instead
 * of silently grading a partial catalog.
 */
export async function eventsListAll(
  conn: Connection,
  maxPages = 20
): Promise<
  | { descriptors: EventDescriptor[]; pages: number; truncatedByBound: boolean }
  | { error: JsonRpcError }
> {
  const out: EventDescriptor[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await eventsListPage(conn, cursor);
    if ('error' in page) return page;
    pages += 1;
    out.push(...page.descriptors);

    const next = page.result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    // A repeated cursor is a server bug; stop rather than loop forever. The
    // pagination check grades it, this helper just refuses to hang.
    if (seen.has(next)) break;
    seen.add(next);
    cursor = next;
  } while (pages < maxPages);

  return { descriptors: out, pages, truncatedByBound: pages >= maxPages };
}

/** The `delivery` array of a descriptor, or `[]` when it is missing/malformed. */
export function deliveryModes(descriptor: EventDescriptor): string[] {
  const d = descriptor.delivery;
  return Array.isArray(d)
    ? d.filter((m): m is string => typeof m === 'string')
    : [];
}

/** The first descriptor advertising `mode`, or `undefined` when none does. */
export function firstSupporting(
  descriptors: EventDescriptor[],
  mode: DeliveryMode
): EventDescriptor | undefined {
  return descriptors.find((d) => deliveryModes(d).includes(mode));
}

/** A descriptor's `name` when it is a usable string, else `undefined`. */
export function descriptorName(
  descriptor: EventDescriptor
): string | undefined {
  return typeof descriptor.name === 'string' && descriptor.name.length > 0
    ? descriptor.name
    : undefined;
}

/**
 * How to refer to a descriptor in an error message without assuming it has a
 * usable `name` — the checks that grade `name` itself run against descriptors
 * that may not.
 */
export function descriptorLabel(
  descriptor: EventDescriptor,
  index: number
): string {
  const name = descriptorName(descriptor);
  return name ? `\`${name}\`` : `events[${index}]`;
}

/**
 * Arguments that satisfy a descriptor's `inputSchema` well enough to poll with.
 *
 * Optional properties are left out, so `{}` means "no filtering". Required
 * properties get a value derived from the schema itself: `default`, `const`,
 * the first `enum` or `examples` entry, then a type-driven value (`minimum`
 * for numbers, a fixed label for strings). A required property the schema
 * gives nothing to go on for returns `undefined`, and the caller reports that
 * as an unmet prerequisite rather than guessing values a server would then
 * reject for the wrong reason.
 */
export function minimalArguments(
  descriptor: EventDescriptor
): Record<string, unknown> | undefined {
  const schema = descriptor.inputSchema;
  if (!isObject(schema)) return {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = isObject(schema.properties) ? schema.properties : {};
  const args: Record<string, unknown> = {};
  for (const key of required) {
    if (typeof key !== 'string') return undefined;
    const value = schemaValue(properties[key]);
    if (value === undefined) return undefined;
    args[key] = value;
  }
  return args;
}

function schemaValue(prop: unknown): unknown {
  if (!isObject(prop)) return undefined;
  if ('default' in prop) return prop.default;
  if ('const' in prop) return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (Array.isArray(prop.examples) && prop.examples.length > 0) {
    return prop.examples[0];
  }
  switch (prop.type) {
    case 'integer':
    case 'number':
      return typeof prop.minimum === 'number' ? prop.minimum : 1;
    case 'string':
      return 'mcp-conformance';
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

/**
 * Call `events/poll`, returning the `JsonRpcError` rather than throwing so the
 * caller can grade error codes.
 */
export async function eventsPoll(
  conn: Connection,
  params: Record<string, unknown>
): Promise<{ result: EventsPollResult } | { error: JsonRpcError }> {
  try {
    const result = await conn.request<EventsPollResult>(
      EVENTS_POLL_METHOD,
      params
    );
    return { result: result ?? {} };
  } catch (err) {
    if (err instanceof JsonRpcError) return { error: err };
    throw err;
  }
}

/** The `events` array of a poll result, or `[]` when missing/malformed. */
export function occurrences(result: EventsPollResult): EventOccurrence[] {
  return Array.isArray(result.events)
    ? (result.events as EventOccurrence[])
    : [];
}

/**
 * Whether a value is an acceptable cursor: a string, `null`, or absent.
 *
 * "Absent means null" is normative in both directions, so a missing field is
 * not a defect and callers must not treat it as one.
 */
export function isValidCursor(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** Whether a value parses as an ISO 8601 instant. */
export function isIso8601(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // Date.parse accepts bare dates and a few non-ISO forms; require at least a
  // date and a time separated by `T`, which every example in the document has.
  return /^\d{4}-\d{2}-\d{2}T/.test(value);
}

/** Whether `code` sits in the JSON-RPC implementation-defined server range. */
export function inServerErrorRange(code: number): boolean {
  return code >= SERVER_ERROR_RANGE_MIN && code <= SERVER_ERROR_RANGE_MAX;
}

/**
 * A name no conformant server should be serving, for probing the "unknown
 * event name" error path. Randomised so a fixture cannot accidentally define
 * it, and prefixed so a human reading server logs knows where it came from.
 */
export function unknownEventName(): string {
  return `conformance.nonexistent.${Math.random().toString(36).slice(2, 10)}`;
}
