/**
 * Composite cells: one MCP URL in front of several scenarios' cells of the
 * same run and revision, so a client that can only be driven by hand (a chat
 * app's connector settings, a deployed agent) needs one URL instead of one
 * per scenario. The children stay ordinary cells with their own logs, checks,
 * results and scoring; the composite only routes each request:
 *
 *   initialize, server/discover            every child, capabilities merged
 *   tools/list, resources/list, …          every child, lists merged
 *   tools/call, resources/read, prompts/get the child that listed the name
 *   notifications                          every child
 *   anything else, GET, DELETE             the first child
 *
 * A composite's path segment is its children's names joined with `+`, e.g.
 * `/s/<run-id>/2026-07-28/tools_call+http-standard-headers/mcp`.
 */

export const COMPOSITE_SEPARATOR = '+';

/** Children that cannot share a URL, and why. */
const NOT_COMPOSABLE: Record<string, string> = {
  'request-metadata':
    "rejects the run's first request on purpose, which would fail the composite's first request",
  'http-invalid-tool-headers':
    'serves malformed tools on purpose, and a strict client drops the whole merged tool list',
  'sse-retry': 'owns every GET and its own session id',
  'elicitation-sep1034-client-defaults':
    'keeps SDK sessions keyed by a session id it mints itself'
};

/** Why `scenario` cannot be a child of a composite, or undefined when it can. */
export function notComposableReason(scenario: string): string | undefined {
  if (scenario.startsWith('auth/')) {
    return "owns the endpoint's 401 and authorization metadata";
  }
  return NOT_COMPOSABLE[scenario];
}

/**
 * The children named by a composite path segment, in order and without
 * repeats, or undefined when the segment is not a composite (no separator).
 */
export function parseComposite(segment: string): string[] | undefined {
  if (!segment.includes(COMPOSITE_SEPARATOR)) return undefined;
  const names = segment.split(COMPOSITE_SEPARATOR).filter(Boolean);
  return [...new Set(names)];
}

/** Ready-made composites the run page offers, per revision. */
export const DEFAULT_COMPOSITES: Record<string, string[]> = {
  '2025-11-25': ['initialize', 'tools_call'],
  '2026-07-28': [
    'tools_call',
    'http-standard-headers',
    'http-custom-headers',
    'json-schema-ref-no-deref',
    'sep-2322-client-request-state'
  ]
};

/** List methods: the result key holding the list, and the key naming an item. */
const LISTS: Record<string, { key: string; id: string }> = {
  'tools/list': { key: 'tools', id: 'name' },
  'prompts/list': { key: 'prompts', id: 'name' },
  'resources/list': { key: 'resources', id: 'uri' },
  'resources/templates/list': { key: 'resourceTemplates', id: 'uriTemplate' }
};

/** Requests addressed to one named item: the param naming it, and its list. */
const ADDRESSED: Record<string, { param: string; list: string }> = {
  'tools/call': { param: 'name', list: 'tools/list' },
  'prompts/get': { param: 'name', list: 'prompts/list' },
  'resources/read': { param: 'uri', list: 'resources/list' }
};

const LIFECYCLE = new Set(['initialize', 'server/discover']);

export type Route =
  | { kind: 'lifecycle' }
  | { kind: 'list'; method: string }
  | { kind: 'addressed'; list: string; item: string }
  | { kind: 'notification' }
  | { kind: 'first' };

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Where one JSON-RPC message goes (see the table at the top of the file). */
export function routeFor(message: Record<string, unknown> | undefined): Route {
  const method = typeof message?.method === 'string' ? message.method : '';
  if (!method) return { kind: 'first' };
  if (message?.id === undefined) return { kind: 'notification' };
  if (LIFECYCLE.has(method)) return { kind: 'lifecycle' };
  if (LISTS[method]) return { kind: 'list', method };
  const addressed = ADDRESSED[method];
  const item = asRecord(message?.params)?.[addressed?.param ?? ''];
  if (addressed && typeof item === 'string') {
    return { kind: 'addressed', list: addressed.list, item };
  }
  return { kind: 'first' };
}

/** A child's JSON-RPC result, or undefined when it answered with an error. */
export type ChildResult = { child: string; result?: Record<string, unknown> };

/**
 * One lifecycle result from several children: the first child's fields, with
 * every child's capabilities merged (a capability's own settings too).
 */
export function mergeLifecycle(
  results: ChildResult[]
): Record<string, unknown> | undefined {
  const answered = results.filter((r) => r.result);
  if (!answered.length) return undefined;
  const capabilities: Record<string, unknown> = {};
  for (const { result } of answered) {
    for (const [name, value] of Object.entries(
      asRecord(result!.capabilities) ?? {}
    )) {
      capabilities[name] = {
        ...(asRecord(capabilities[name]) ?? {}),
        ...(asRecord(value) ?? {})
      };
    }
  }
  return { ...answered[0].result, capabilities };
}

/**
 * One list result from several children, and which child owns each item.
 * The first child to list a name keeps it; a later duplicate is dropped.
 */
export function mergeList(
  method: string,
  results: ChildResult[]
):
  | { result: Record<string, unknown>; owners: Map<string, string> }
  | undefined {
  const spec = LISTS[method];
  const answered = results.filter((r) => r.result);
  if (!spec || !answered.length) return undefined;
  const items: unknown[] = [];
  const owners = new Map<string, string>();
  for (const { child, result } of answered) {
    const list = result![spec.key];
    for (const item of Array.isArray(list) ? list : []) {
      const id = asRecord(item)?.[spec.id];
      if (typeof id !== 'string' || owners.has(id)) continue;
      owners.set(id, child);
      items.push(item);
    }
  }
  return { result: { [spec.key]: items }, owners };
}

/** Key for an owned item in the composite's owner map (list names have no `|`). */
export function ownerKey(list: string, item: string): string {
  return `${list}|${item}`;
}

/** What the composite's page (and its JSON) shows. */
export interface CompositeView {
  runId: string;
  revision: string;
  /** The one MCP URL the client under test is given. */
  url: string;
  /** Results for the whole column, where every child's verdict appears. */
  resultsUrl: string;
  children: {
    scenario: string;
    description: string;
    resultsUrl: string;
    steps?: readonly import('../steps').Step[];
  }[];
}
