/**
 * SEP-3415 "Streamable HTTP: Routing Headers". `events/poll`, `events/stream`,
 * `events/subscribe` and `events/unsubscribe` carry `Mcp-Name: <params.name>`,
 * and a server rejects one whose header is missing or does not match the body
 * with HTTP 400 and `-32020 HeaderMismatch`. `events/list` has no
 * `params.name` and carries no `Mcp-Name`.
 *
 * `Connection.request` can override a header but not drop one, and cannot set
 * either on the stateful wire, so each probe is its own POST. A server that
 * accepts a bad `events/stream` probe answers with a stream, which the probe
 * aborts once it has the status line.
 *
 * The header comes from SEP-2243, which is a 2026-07-28 rule, and SEP-3415 is
 * defined for 2026-07-28 and later. On an earlier lifecycle these rows skip.
 */

import {
  buildStandardHeaders,
  isStateless,
  withRequestMeta,
  type RunContext
} from '../../../connection';
import { HEADER_MISMATCH } from '../../../spec-types/draft';
import type { ConformanceCheck } from '../../../types';
import { EVENTS_LIST_METHOD, eventsCheck, isObject } from './helpers';

export const MCP_NAME_MISSING_ID = 'sep-3415-mcp-name-missing-rejected';
export const MCP_NAME_MISMATCH_ID = 'sep-3415-mcp-name-mismatch-rejected';
export const MCP_NAME_LIST_EXEMPT_ID = 'sep-3415-mcp-name-list-exempt';

/** The two rows every scenario that sends a named `events/*` request grades. */
export const MCP_NAME_IDS = [
  MCP_NAME_MISSING_ID,
  MCP_NAME_MISMATCH_ID
] as const;

const REJECT_DESCRIPTION =
  'A request whose `Mcp-Name` header is missing, or does not match `params.name`, is rejected with HTTP status `400 Bad Request` and `HeaderMismatch` (`-32020`).';
const LIST_DESCRIPTION =
  '`events/list` has no `params.name` and carries no `Mcp-Name` header.';

const LEGACY_REASON =
  'The `Mcp-Name` routing header is a SEP-2243 rule of the 2026-07-28 Streamable HTTP transport, and SEP-3415 is defined for 2026-07-28 and later. Rerun with `--spec-version 2026-07-28` to grade it.';

/** One named `events/*` request to send with a bad header. */
export interface McpNameProbe {
  method: string;
  params: Record<string, unknown>;
}

interface ProbeOutcome {
  status: number;
  code?: number;
  /** The server answered with a stream, so it accepted the request. */
  streamed: boolean;
}

/**
 * POST `method` with the standard headers, then replace `Mcp-Name` with
 * `mcpName`, or leave it off when `mcpName` is null.
 */
async function send(
  ctx: RunContext,
  method: string,
  params: Record<string, unknown>,
  mcpName: string | null
): Promise<ProbeOutcome> {
  const headers = buildStandardHeaders(method, params, {
    specVersion: ctx.specVersion
  });
  delete headers['Mcp-Name'];
  if (mcpName !== null) headers['Mcp-Name'] = mcpName;

  const controller = new AbortController();
  const res = await fetch(ctx.serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1_000_000) + 1,
      method,
      params: withRequestMeta(params, ctx.specVersion)
    }),
    signal: controller.signal
  });
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    controller.abort();
    return { status: res.status, streamed: true };
  }
  let code: number | undefined;
  try {
    const body: unknown = JSON.parse(await res.text());
    if (isObject(body) && isObject(body.error)) code = Number(body.error.code);
  } catch {
    // A 400 with no JSON-RPC body still fails the code half of the rule.
  }
  return { status: res.status, code, streamed: false };
}

function describeOutcome(o: ProbeOutcome): string {
  if (o.streamed) return `HTTP ${o.status} with an open stream`;
  return o.code === undefined
    ? `HTTP ${o.status} with no JSON-RPC error`
    : `HTTP ${o.status} with ${o.code}`;
}

function rejected(o: ProbeOutcome): boolean {
  return !o.streamed && o.status === 400 && o.code === HEADER_MISMATCH;
}

/**
 * Grade the missing and mismatched rows over every probe given. Each row
 * passes only if every method rejected its bad header.
 */
export async function mcpNameChecks(
  ctx: RunContext,
  probes: McpNameProbe[]
): Promise<ConformanceCheck[]> {
  if (!isStateless(ctx)) {
    return MCP_NAME_IDS.map((id) =>
      eventsCheck(id, REJECT_DESCRIPTION, 'SKIPPED', {
        errorMessage: LEGACY_REASON
      })
    );
  }

  const cases: Array<{
    id: string;
    header: (p: McpNameProbe) => string | null;
    what: string;
  }> = [
    { id: MCP_NAME_MISSING_ID, header: () => null, what: 'no `Mcp-Name`' },
    {
      id: MCP_NAME_MISMATCH_ID,
      header: (p) => `${String(p.params.name)}-mismatch`,
      what: '`Mcp-Name` naming a different event'
    }
  ];

  const out: ConformanceCheck[] = [];
  for (const c of cases) {
    const outcomes: Record<string, string> = {};
    const wrong: string[] = [];
    for (const p of probes) {
      const o = await send(ctx, p.method, p.params, c.header(p));
      outcomes[p.method] = describeOutcome(o);
      if (!rejected(o)) wrong.push(`\`${p.method}\` (${describeOutcome(o)})`);
    }
    out.push(
      eventsCheck(
        c.id,
        REJECT_DESCRIPTION,
        wrong.length === 0 ? 'SUCCESS' : 'FAILURE',
        {
          details: outcomes,
          errorMessage:
            wrong.length === 0
              ? undefined
              : `Sent with ${c.what}, these were not rejected with HTTP 400 and ${HEADER_MISMATCH}: ${wrong.join(', ')}.`
        }
      )
    );
  }
  return out;
}

/** `events/list` without `Mcp-Name` must not be refused for lacking one. */
export async function mcpNameListExemptCheck(
  ctx: RunContext
): Promise<ConformanceCheck> {
  if (!isStateless(ctx)) {
    return eventsCheck(MCP_NAME_LIST_EXEMPT_ID, LIST_DESCRIPTION, 'SKIPPED', {
      errorMessage: LEGACY_REASON
    });
  }
  const o = await send(ctx, EVENTS_LIST_METHOD, {}, null);
  const refused = o.status === 400 || o.code === HEADER_MISMATCH;
  return eventsCheck(
    MCP_NAME_LIST_EXEMPT_ID,
    LIST_DESCRIPTION,
    refused ? 'FAILURE' : 'SUCCESS',
    {
      details: { outcome: describeOutcome(o) },
      errorMessage: refused
        ? `\`${EVENTS_LIST_METHOD}\` sent without \`Mcp-Name\` was refused (${describeOutcome(o)}), but it has no \`params.name\` to mirror.`
        : undefined
    }
  );
}
