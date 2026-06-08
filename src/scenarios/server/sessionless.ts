/**
 * Sessionless Streamable HTTP scenarios for MCP servers (SEP-2567).
 *
 * SEP-2567 removes protocol-level sessions and the `Mcp-Session-Id` header
 * from the Streamable HTTP transport. This scenario verifies the observable
 * consequences against a server speaking the draft revision:
 *
 * - requests that carry no session header are served normally (there is no
 *   session mechanism left to require);
 * - list endpoints (`tools/list`, `resources/list`, `prompts/list`) do not
 *   vary per-connection or as a side effect of other requests — every
 *   harness request arrives on an independent connection, so two snapshots
 *   with unrelated requests interleaved must agree;
 * - a server that supports only this revision handles legacy session-era
 *   traffic as the spec's backward-compatibility section says it SHOULD:
 *   405 for GET/DELETE, ignore `Mcp-Session-Id` (and do not mint or echo
 *   session IDs), ignore `Last-Event-ID`.
 *
 * The backward-compatibility checks only apply to servers that support
 * *only* the draft revision. Dual-era servers (which also serve the legacy
 * `initialize` handshake) implement the corresponding revision's behavior
 * instead, so those checks report SKIPPED for them. Era is detected by
 * probing with a legacy-shaped `initialize` request.
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  sendStatelessRequest,
  readSseJsonRpcResponse,
  type RunContext,
  type StatelessResponse
} from '../../connection';

const SEP_URL =
  'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567';
const TRANSPORT_BACKCOMPAT_URL =
  'https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http#earlier-streamable-http-revisions';

const SESSION_HEADER = 'Mcp-Session-Id';

interface ListEndpoint {
  capability: 'tools' | 'resources' | 'prompts';
  method: 'tools/list' | 'resources/list' | 'prompts/list';
  /** Result field holding the list. */
  field: 'tools' | 'resources' | 'prompts';
  /** Item property that identifies a list entry. */
  idKey: 'name' | 'uri';
  specUrl: string;
}

const LIST_ENDPOINTS: ListEndpoint[] = [
  {
    capability: 'tools',
    method: 'tools/list',
    field: 'tools',
    idKey: 'name',
    specUrl:
      'https://modelcontextprotocol.io/specification/draft/server/tools#capabilities'
  },
  {
    capability: 'resources',
    method: 'resources/list',
    field: 'resources',
    idKey: 'uri',
    specUrl:
      'https://modelcontextprotocol.io/specification/draft/server/resources#capabilities'
  },
  {
    capability: 'prompts',
    method: 'prompts/list',
    field: 'prompts',
    idKey: 'name',
    specUrl:
      'https://modelcontextprotocol.io/specification/draft/server/prompts#capabilities'
  }
];

/** Read a response header defensively (mocks may omit `headers`). */
function getHeader(res: { headers?: Headers }, name: string): string | null {
  return typeof res.headers?.get === 'function' ? res.headers.get(name) : null;
}

export class ServerSessionlessScenario implements ClientScenario {
  name = 'server-sessionless';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test sessionless Streamable HTTP operation (SEP-2567).

SEP-2567 removes protocol-level sessions and the Mcp-Session-Id header from
the Streamable HTTP transport. This scenario verifies:

1. **No session required** — a request without any Mcp-Session-Id header is
   served normally; the server does not reject it demanding a session.
2. **List-endpoint connection invariance** — for each list capability the
   server declares (tools, resources, prompts), two list snapshots taken on
   independent connections, with unrelated requests interleaved, return the
   same set. The set may legitimately vary by the authorization presented on
   the request, but not per-connection.
3. **Legacy-traffic handling (2026-only servers, SHOULD)** — a server that
   supports only this revision responds 405 to HTTP GET/DELETE, ignores an
   Mcp-Session-Id request header without minting or echoing session IDs, and
   ignores Last-Event-ID. Dual-era servers (which still serve the legacy
   initialize handshake) implement the legacy revision's behavior instead,
   so these checks are SKIPPED for them.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    function pushCheck(args: {
      id: string;
      name: string;
      description: string;
      specUrl?: string;
      error?: string;
      warning?: boolean;
      skipped?: boolean;
      details?: Record<string, unknown>;
    }) {
      checks.push({
        id: args.id,
        name: args.name,
        description: args.description,
        status: args.error
          ? args.warning
            ? 'WARNING'
            : 'FAILURE'
          : args.skipped
            ? 'SKIPPED'
            : 'SUCCESS',
        timestamp,
        errorMessage: args.error || undefined,
        specReferences: [
          { id: 'SEP-2567', url: SEP_URL },
          ...(args.specUrl ? [{ id: 'spec', url: args.specUrl }] : [])
        ],
        details: args.details
      });
    }

    const send = (
      method: string,
      params?: Record<string, unknown>,
      headers?: Record<string, string>
    ): Promise<StatelessResponse> =>
      sendStatelessRequest(serverUrl, method, params, {
        headers,
        specVersion
      });

    // ==========================================================
    // 1. Requests without a session header are served normally.
    // ==========================================================
    let discoverCapabilities: Record<string, unknown> = {};
    let noSessionResponse: StatelessResponse | null = null;
    let noSessionError: string | undefined;
    try {
      noSessionResponse = await send('server/discover');
      const result = (
        noSessionResponse.body as { result?: unknown } | undefined
      )?.result as { capabilities?: Record<string, unknown> } | undefined;
      if (noSessionResponse.status !== 200 || !result) {
        const rpcError = (
          noSessionResponse.body as { error?: { message?: string } } | undefined
        )?.error;
        noSessionError =
          `Expected a server/discover request without an ${SESSION_HEADER} ` +
          `header to succeed, got HTTP ${noSessionResponse.status}` +
          (rpcError?.message ? ` (${rpcError.message})` : '');
      } else if (
        result.capabilities &&
        typeof result.capabilities === 'object'
      ) {
        discoverCapabilities = result.capabilities as Record<string, unknown>;
      }
    } catch (e) {
      noSessionError = `Request without ${SESSION_HEADER} failed: ${String(e)}`;
    }

    pushCheck({
      id: 'sep-2567-server-accepts-requests-without-session-id',
      name: 'ServerAcceptsRequestsWithoutSessionId',
      description:
        'Protocol-level sessions are removed at the draft revision: a request ' +
        `carrying no ${SESSION_HEADER} header is served normally`,
      specUrl: 'https://modelcontextprotocol.io/specification/draft/changelog',
      error: noSessionError,
      details: { httpStatus: noSessionResponse?.status }
    });

    // ==========================================================
    // 2. List endpoints do not vary per-connection or as a side
    //    effect of other requests on the connection.
    // ==========================================================

    // Collect the full (paginated) list for an endpoint. Every request goes
    // out as an independent HTTP request — there is no session or pinned
    // connection to scope the result to.
    const collectList = async (
      endpoint: ListEndpoint
    ): Promise<{ ids: string[]; error?: string }> => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await send(
          endpoint.method,
          cursor !== undefined ? { cursor } : undefined
        );
        const body = res.body as
          | {
              result?: { nextCursor?: string } & Record<string, unknown>;
              error?: { code?: number; message?: string };
            }
          | undefined;
        if (res.status !== 200 || !body?.result) {
          return {
            ids,
            error:
              `${endpoint.method} returned HTTP ${res.status}` +
              (body?.error ? ` (${body.error.message})` : '')
          };
        }
        const items = body.result[endpoint.field];
        if (!Array.isArray(items)) {
          return {
            ids,
            error: `${endpoint.method} result has no ${endpoint.field} array`
          };
        }
        for (const item of items) {
          ids.push(String((item as Record<string, unknown>)[endpoint.idKey]));
        }
        cursor = body.result.nextCursor;
        if (cursor === undefined) break;
      }
      return { ids: ids.sort() };
    };

    const declaredEndpoints = LIST_ENDPOINTS.filter(
      (e) => discoverCapabilities[e.capability]
    );

    for (const endpoint of LIST_ENDPOINTS) {
      const checkId = `sep-2567-${endpoint.capability}-list-connection-invariant`;
      const checkName = `${endpoint.capability[0].toUpperCase()}${endpoint.capability.slice(1)}ListConnectionInvariant`;
      const description =
        `${endpoint.method} returns the same set across independent ` +
        'connections and is not changed as a side effect of other requests';

      if (!discoverCapabilities[endpoint.capability]) {
        pushCheck({
          id: checkId,
          name: checkName,
          description,
          specUrl: endpoint.specUrl,
          skipped: true,
          details: {
            note: `Server did not declare the ${endpoint.capability} capability in server/discover`
          }
        });
        continue;
      }

      try {
        const first = await collectList(endpoint);
        if (first.error) {
          pushCheck({
            id: checkId,
            name: checkName,
            description,
            specUrl: endpoint.specUrl,
            error: first.error
          });
          continue;
        }

        // Interleave unrelated, side-effect-free requests before the second
        // snapshot: a discovery call plus one page of each *other* declared
        // list endpoint.
        await send('server/discover');
        for (const other of declaredEndpoints) {
          if (other.capability !== endpoint.capability) {
            await send(other.method);
          }
        }

        const second = await collectList(endpoint);
        if (second.error) {
          pushCheck({
            id: checkId,
            name: checkName,
            description,
            specUrl: endpoint.specUrl,
            error: second.error
          });
          continue;
        }

        const same =
          first.ids.length === second.ids.length &&
          first.ids.every((id, i) => id === second.ids[i]);
        pushCheck({
          id: checkId,
          name: checkName,
          description,
          specUrl: endpoint.specUrl,
          error: same
            ? undefined
            : `${endpoint.method} diverged between two requests with identical ` +
              `inputs: [${first.ids.join(', ')}] then [${second.ids.join(', ')}]. ` +
              'The set must not vary per-connection or as a side effect of ' +
              'other requests.',
          details: { first: first.ids, second: second.ids }
        });
      } catch (e) {
        pushCheck({
          id: checkId,
          name: checkName,
          description,
          specUrl: endpoint.specUrl,
          error: String(e)
        });
      }
    }

    // ==========================================================
    // 3. Legacy session-era traffic (2026-only servers, SHOULD).
    // ==========================================================

    // Era probe: a server that also serves the legacy `initialize` handshake
    // is dual-era; the backward-compatibility SHOULDs below are scoped to
    // servers that support *only* the draft revision, so they are SKIPPED
    // for dual-era servers. The probe mimics a legacy client: no
    // MCP-Protocol-Version header, no per-request _meta.
    let dualEra = false;
    try {
      const probeId = 90001;
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: probeId,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'conformance-era-probe', version: '1.0.0' }
          }
        })
      });
      const contentType = getHeader(res, 'content-type') ?? '';
      let body: unknown;
      if (contentType.includes('text/event-stream')) {
        body = (await readSseJsonRpcResponse(res, probeId)).body;
      } else {
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
      }
      dualEra =
        res.status === 200 &&
        (body as { result?: { protocolVersion?: string } } | undefined)?.result
          ?.protocolVersion !== undefined;
    } catch {
      // Probe failure means we cannot prove the server is dual-era; treat it
      // as draft-only and let the checks below speak for themselves.
    }

    const dualEraSkip = {
      skipped: true,
      details: {
        note:
          'Server also serves the legacy initialize handshake (dual-era). ' +
          'The backward-compatibility SHOULDs apply only to servers that ' +
          'support the draft revision exclusively.'
      }
    };

    // --- GET / DELETE respond 405 Method Not Allowed ---
    {
      const checkArgs = {
        id: 'sep-2567-server-rejects-get-and-delete',
        name: 'ServerRejectsGetAndDelete',
        description:
          'A draft-only server responds 405 Method Not Allowed to HTTP GET ' +
          'and DELETE on the MCP endpoint (SHOULD)',
        specUrl: TRANSPORT_BACKCOMPAT_URL
      };
      if (dualEra) {
        pushCheck({ ...checkArgs, ...dualEraSkip });
      } else {
        try {
          const getRes = await fetch(serverUrl, {
            method: 'GET',
            headers: { Accept: 'text/event-stream' }
          });
          const deleteRes = await fetch(serverUrl, { method: 'DELETE' });
          const wrong: string[] = [];
          if (getRes.status !== 405) {
            wrong.push(`GET returned ${getRes.status}`);
          }
          if (deleteRes.status !== 405) {
            wrong.push(`DELETE returned ${deleteRes.status}`);
          }
          pushCheck({
            ...checkArgs,
            warning: true,
            error:
              wrong.length > 0
                ? `Expected 405 Method Not Allowed: ${wrong.join('; ')}`
                : undefined,
            details: { get: getRes.status, delete: deleteRes.status }
          });
        } catch (e) {
          pushCheck({ ...checkArgs, warning: true, error: String(e) });
        }
      }
    }

    // --- Mcp-Session-Id on a request is ignored; no minting/echoing ---
    {
      const checkArgs = {
        id: 'sep-2567-server-ignores-session-id',
        name: 'ServerIgnoresSessionId',
        description:
          `A draft-only server ignores an ${SESSION_HEADER} request header ` +
          'and does not mint or echo session IDs (SHOULD)',
        specUrl: TRANSPORT_BACKCOMPAT_URL
      };
      if (dualEra) {
        pushCheck({ ...checkArgs, ...dualEraSkip });
      } else {
        try {
          const staleSessionId = 'conformance-stale-session-id';
          const res = await send('server/discover', undefined, {
            [SESSION_HEADER]: staleSessionId
          });
          const result = (res.body as { result?: unknown } | undefined)?.result;
          const problems: string[] = [];
          if (res.status !== 200 || !result) {
            problems.push(
              `request carrying a stale ${SESSION_HEADER} header was not ` +
                `served normally (HTTP ${res.status})`
            );
          }
          const echoed = getHeader(res, SESSION_HEADER);
          if (echoed !== null) {
            problems.push(
              echoed === staleSessionId
                ? `response echoed the ${SESSION_HEADER} header`
                : `response minted an ${SESSION_HEADER} header (${echoed})`
            );
          }
          // The session-less baseline response must not mint one either.
          if (
            noSessionResponse &&
            getHeader(noSessionResponse, SESSION_HEADER) !== null
          ) {
            problems.push(
              `response to a request without ${SESSION_HEADER} minted one ` +
                `(${getHeader(noSessionResponse, SESSION_HEADER)})`
            );
          }
          pushCheck({
            ...checkArgs,
            warning: true,
            error: problems.length > 0 ? problems.join('; ') : undefined,
            details: { httpStatus: res.status }
          });
        } catch (e) {
          pushCheck({ ...checkArgs, warning: true, error: String(e) });
        }
      }
    }

    // --- Last-Event-ID on a request is ignored ---
    {
      const checkArgs = {
        id: 'sep-2567-server-ignores-last-event-id',
        name: 'ServerIgnoresLastEventId',
        description:
          'A draft-only server ignores a Last-Event-ID request header; ' +
          'streams are not resumable (SHOULD)',
        specUrl: TRANSPORT_BACKCOMPAT_URL
      };
      if (dualEra) {
        pushCheck({ ...checkArgs, ...dualEraSkip });
      } else {
        try {
          const res = await send('server/discover', undefined, {
            'Last-Event-ID': '42'
          });
          const result = (res.body as { result?: unknown } | undefined)?.result;
          pushCheck({
            ...checkArgs,
            warning: true,
            error:
              res.status === 200 && result
                ? undefined
                : `request carrying a Last-Event-ID header was not served ` +
                  `normally (HTTP ${res.status})`,
            details: { httpStatus: res.status }
          });
        } catch (e) {
          pushCheck({ ...checkArgs, warning: true, error: String(e) });
        }
      }
    }

    return checks;
  }
}
