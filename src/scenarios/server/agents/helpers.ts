/**
 * Shared helpers for the agents-wg#22 (MCP Agent Discovery Extension) server
 * conformance scenarios under this directory.
 *
 * The scenarios treat the server under test as an arbitrary server declaring
 * `io.modelcontextprotocol/agents`. Capability is read from discovery, never
 * inferred from an error, and every agent is found through `agents/list`, so
 * no fixture-specific agent name is hardcoded. The two rows that need an agent
 * the harness cannot otherwise find (one hidden from this caller, one whose
 * membership names a missing tool) ask the server's diagnostic control for
 * their names, and report untestable when it is absent.
 *
 * The SEP has no number in modelcontextprotocol/modelcontextprotocol yet, so
 * check IDs carry the placeholder `sep-9998-`. See src/seps/sep-9998.yaml.
 */

import type {
  CheckStatus,
  ConformanceCheck,
  SpecReference
} from '../../../types';
import type { Connection } from '../../../connection';
import { JsonRpcError } from '../../../connection';

export const AGENTS_EXTENSION_ID = 'io.modelcontextprotocol/agents';

export const AGENTS_LIST_METHOD = 'agents/list';
export const AGENTS_GET_METHOD = 'agents/get';
export const AGENTS_LIST_CHANGED_NOTIFICATION =
  'notifications/agents/list_changed';

/** The `subscriptions/listen` filter key the SEP defines. */
export const AGENTS_LIST_CHANGED_FILTER_KEY = 'agentsListChanged';

export const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';
export const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  'notifications/subscriptions/acknowledged';

export const REASON_AGENT_NOT_FOUND = 'agent_not_found';
export const REASON_INVALID_AGENT_DEFINITION = 'invalid_agent_definition';

export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export const MODEL_ROLES = ['small', 'medium', 'large'] as const;

/**
 * Diagnostic controls the fixture exposes as tools. Both are optional: a
 * server without them reports the rows that depend on them as untestable,
 * naming the missing tool.
 *
 * `agents_conformance_fixture` takes no arguments and answers with a text
 * item holding `{"hiddenAgent": "<name>", "brokenAgent": "<name>"}`: an agent
 * hidden from this caller, and one whose membership names a tool missing from
 * the catalog. `agents_conformance_add_agent` takes `{"name": string}` and
 * adds a valid agent, which is how the harness changes the roster mid-run.
 */
export const CONTROL_FIXTURE = 'agents_conformance_fixture';
export const CONTROL_ADD_AGENT = 'agents_conformance_add_agent';

const SEP_URL =
  'https://github.com/modelcontextprotocol/agents-wg/blob/9b16840e2f958b3dd9a418bb321189a0d1ab3493/proposals/0000-mcp-agent-discovery-extension.md';

export const AGENTS_SPEC_REF: SpecReference = {
  id: 'agents-wg#22 (MCP Agent Discovery Extension)',
  url: `${SEP_URL}#specification`
};

/**
 * Build a check carrying the SEP reference. Per AGENTS.md the same `id` flips
 * `status` + `errorMessage` between SUCCESS and FAILURE rather than branching
 * into distinct slugs.
 */
export function agentsCheck(
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
    specReferences: [AGENTS_SPEC_REF],
    ...extras
  };
}

/** A JSON object, as opposed to an array, `null`, or a primitive. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How to name an observed value's type in an error message. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

export function joinErrs(errs: string[], limit = 5): string {
  const shown = errs.slice(0, limit).join('; ');
  return errs.length > limit
    ? `${shown} (+${errs.length - limit} more)`
    : shown;
}

/** The client capabilities the harness declares: the base set plus this extension. */
export const AGENTS_CLIENT_CAPABILITIES = {
  sampling: {},
  elicitation: {},
  roots: { listChanged: true },
  extensions: { [AGENTS_EXTENSION_ID]: {} }
};

/**
 * What the server declared under `capabilities.extensions` for this
 * extension. `declared` tells absent apart from malformed.
 */
export async function declaredAgentsCapability(
  conn: Connection
): Promise<{ declared: boolean; value: unknown }> {
  const discovered = await conn.discover();
  const caps = (discovered.capabilities as Record<string, unknown>) ?? {};
  const extensions = caps.extensions as Record<string, unknown> | undefined;
  if (!isObject(extensions) || !(AGENTS_EXTENSION_ID in extensions)) {
    return { declared: false, value: undefined };
  }
  return { declared: true, value: extensions[AGENTS_EXTENSION_ID] };
}

/** A JSON-RPC error, as thrown by `conn.request`. */
export interface RpcFailure {
  code: number;
  message: string;
  data?: unknown;
}

export function toRpcFailure(err: unknown): RpcFailure {
  if (err instanceof JsonRpcError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  return { code: 0, message: String(err) };
}

/** The `data.reason` of an error, when it carries one. */
export function errorReason(failure: RpcFailure): string | undefined {
  return isObject(failure.data) && typeof failure.data.reason === 'string'
    ? failure.data.reason
    : undefined;
}

export interface ListPage {
  result: Record<string, unknown>;
  agents: unknown[];
}

/**
 * Walk `agents/list` from the first page, following `nextCursor` until the
 * server stops sending one. `truncated` means the walk was cut off because
 * the server kept answering with a cursor (or repeated one).
 */
export async function agentsListAll(
  conn: Connection,
  maxPages = 50
): Promise<
  | { pages: ListPage[]; truncated: boolean }
  | { error: RpcFailure; pages: ListPage[] }
> {
  const pages: ListPage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    let result: Record<string, unknown>;
    try {
      result = await conn.request<Record<string, unknown>>(
        AGENTS_LIST_METHOD,
        cursor === undefined ? {} : { cursor }
      );
    } catch (err) {
      return { error: toRpcFailure(err), pages };
    }
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    pages.push({ result: isObject(result) ? result : {}, agents });
    const next = result?.nextCursor;
    if (typeof next !== 'string' || next === '') {
      return { pages, truncated: false };
    }
    if (seen.has(next)) return { pages, truncated: true };
    seen.add(next);
    cursor = next;
  }
  return { pages, truncated: true };
}

/** `agents/get` for one name, as a result or a JSON-RPC failure. */
export async function agentsGet(
  conn: Connection,
  name: string
): Promise<{ result: Record<string, unknown> } | { error: RpcFailure }> {
  try {
    const result = await conn.request<Record<string, unknown>>(
      AGENTS_GET_METHOD,
      { name }
    );
    return { result: isObject(result) ? result : {} };
  } catch (err) {
    return { error: toRpcFailure(err) };
  }
}

/** Every tool `tools/list` serves, following cursors. */
export async function toolsListAll(
  conn: Connection,
  maxPages = 50
): Promise<Record<string, unknown>[] | RpcFailure> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    let res: { tools?: unknown; nextCursor?: unknown };
    try {
      res = await conn.request('tools/list', cursor ? { cursor } : {});
    } catch (err) {
      return toRpcFailure(err);
    }
    for (const t of Array.isArray(res.tools) ? res.tools : []) {
      if (isObject(t)) out.push(t);
    }
    if (typeof res.nextCursor !== 'string' || res.nextCursor === '') break;
    cursor = res.nextCursor;
  }
  return out;
}

/**
 * Call a diagnostic control and return its first text item, or undefined
 * when the server rejected it or answered with an error result.
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
 * Ask `agents_conformance_fixture` for the names of the hidden and the broken
 * agent. Returns undefined when the control is missing or answers with
 * something other than the documented JSON.
 */
export async function fixtureNames(
  conn: Connection,
  tools: Record<string, unknown>[]
): Promise<{ hiddenAgent?: string; brokenAgent?: string } | undefined> {
  if (!tools.some((t) => t.name === CONTROL_FIXTURE)) return undefined;
  const text = await askControl(conn, CONTROL_FIXTURE, {});
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return undefined;
    return {
      hiddenAgent:
        typeof parsed.hiddenAgent === 'string' ? parsed.hiddenAgent : undefined,
      brokenAgent:
        typeof parsed.brokenAgent === 'string' ? parsed.brokenAgent : undefined
    };
  } catch {
    return undefined;
  }
}

/** A name no conformant server should serve, for the not-found probe. */
export const UNKNOWN_AGENT_NAME = 'mcp-conformance-nonexistent-agent-7c41d2';

/** A result's cache hints are a non-negative number and a known scope. */
export function cacheableResultErrors(
  result: Record<string, unknown>
): string[] {
  const errs: string[] = [];
  const ttl = result.ttlMs;
  if (ttl === undefined) {
    errs.push('ttlMs is absent');
  } else if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
    errs.push(`ttlMs is ${JSON.stringify(ttl)}, not a non-negative number`);
  }
  const scope = result.cacheScope;
  if (scope === undefined) {
    errs.push('cacheScope is absent');
  } else if (scope !== 'public' && scope !== 'private') {
    errs.push(
      `cacheScope is ${JSON.stringify(scope)}, not "public" or "private"`
    );
  }
  return errs;
}
