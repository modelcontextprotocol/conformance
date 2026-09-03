/**
 * Session lifecycle conformance test scenario for MCP servers.
 *
 * Verifies the two server-side guarantees the Streamable HTTP transport spec
 * places on session termination:
 *
 *   1. The server accepts an HTTP DELETE that carries the issued session ID.
 *   2. After such a DELETE, a subsequent request bearing the terminated
 *      session ID is rejected with HTTP 404 Not Found.
 *
 * See https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import { readSseJsonRpcResponse, type RunContext } from '../../connection';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Session-Management',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management'
  }
];

const INITIALIZE_REQUEST_ID = 1;

/**
 * How long to wait for the initialize result body before giving up on
 * extracting the negotiated protocol version. A server that answers the
 * initialize POST with a long-lived SSE stream and never emits the response
 * must not hang the run; on timeout the caller falls back to the requested
 * spec version.
 */
const NEGOTIATED_VERSION_TIMEOUT_MS = 5_000;

const TOOLS_LIST_BODY = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {}
};

interface CheckDef {
  id: string;
  name: string;
  description: string;
}

const LIFECYCLE_ERROR: CheckDef = {
  id: 'server-session-lifecycle-error',
  name: 'SessionLifecycleError',
  description: 'Session lifecycle test execution'
};

const INITIALIZED_ACCEPTED: CheckDef = {
  id: 'server-session-initialized-accepted',
  name: 'SessionInitializedAccepted',
  description:
    'Server accepts the initialized notification on the issued session ID with a 2xx response'
};

const DELETE_ACCEPTED: CheckDef = {
  id: 'server-session-delete-accepted',
  name: 'SessionDeleteAccepted',
  description: 'Server accepts HTTP DELETE on the issued session ID'
};

const TERMINATED_RETURNS_404: CheckDef = {
  id: 'server-session-terminated-returns-404',
  name: 'SessionTerminatedReturns404',
  description:
    'Server returns HTTP 404 for requests bearing a terminated session ID'
};

function check(
  def: CheckDef,
  status: ConformanceCheck['status'],
  extras: Pick<Partial<ConformanceCheck>, 'errorMessage' | 'details'> = {}
): ConformanceCheck {
  return {
    ...def,
    status,
    timestamp: new Date().toISOString(),
    specReferences: SPEC_REFERENCES,
    ...extras
  };
}

/**
 * Extract the protocol version the server negotiated in its initialize
 * result. Returns undefined when the body cannot be parsed or does not
 * arrive within the timeout; the caller falls back to the requested spec
 * version.
 */
async function negotiatedProtocolVersion(
  initResponse: Response
): Promise<string | undefined> {
  const parse = async (): Promise<string | undefined> => {
    const contentType = initResponse.headers.get('content-type') ?? '';
    let body: unknown;
    if (contentType.includes('text/event-stream')) {
      body = (await readSseJsonRpcResponse(initResponse, INITIALIZE_REQUEST_ID))
        .body;
    } else {
      body = await initResponse.json();
    }
    const result = (body as { result?: { protocolVersion?: unknown } } | null)
      ?.result;
    return typeof result?.protocolVersion === 'string'
      ? result.protocolVersion
      : undefined;
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      parse(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => resolve(undefined),
          NEGOTIATED_VERSION_TIMEOUT_MS
        );
      })
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export class SessionLifecycleScenario implements ClientScenario {
  name = 'server-session-lifecycle';
  // Sessions were removed entirely from the draft spec (SEP-2575), so the
  // lifecycle checks only apply to the dated stateful versions.
  readonly source = {
    introducedIn: '2025-03-26',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description = `Verify the server honours the streamable-HTTP session
termination contract.

**Server Implementation Requirements:**

- Accept an HTTP DELETE to the MCP endpoint that carries the issued
  \`Mcp-Session-Id\` header (or respond 405 if the server does not support
  explicit termination). The spec does not pin a success status, so any
  other response is reported as a warning rather than a failure.
- After such a DELETE, return HTTP 404 Not Found for subsequent requests
  bearing the terminated session ID.

Servers without session management (stateless) are reported as SKIPPED.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];

    // Every fetch in this scenario shares one AbortController: cancel() on
    // a body whose reader is still locked rejects, so aborting the fetch is
    // the only reliable way to drop a never-ending SSE stream (initialize
    // or any follow-up response) once the scenario finishes.
    const abort = new AbortController();

    try {
      // initialize MUST NOT carry MCP-Protocol-Version (the version is being
      // negotiated by the initialize handshake itself).
      const initResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: INITIALIZE_REQUEST_ID,
          method: 'initialize',
          params: {
            protocolVersion: specVersion,
            capabilities: {},
            clientInfo: {
              name: 'conformance-session-lifecycle-test',
              version: '1.0.0'
            }
          }
        }),
        signal: abort.signal
      });

      if (!initResponse.ok) {
        checks.push(
          check(LIFECYCLE_ERROR, 'FAILURE', {
            errorMessage: `initialize failed with HTTP ${initResponse.status}; cannot exercise session lifecycle`,
            details: { statusCode: initResponse.status }
          })
        );
        return checks;
      }

      const sessionId = initResponse.headers.get('mcp-session-id');

      if (!sessionId) {
        checks.push(
          check(
            {
              id: 'server-session-lifecycle-skipped',
              name: 'SessionLifecycleSkipped',
              description:
                'Server is stateless (no MCP-Session-Id) — lifecycle checks not applicable'
            },
            'INFO',
            {
              details: {
                message:
                  'Server did not return an MCP-Session-Id header; session lifecycle does not apply.'
              }
            }
          )
        );
        return checks;
      }

      // Follow-up requests carry the version the server actually negotiated
      // (2025-06-18+ says the client SHOULD send the negotiated version, and
      // servers MAY reject versions they don't support with 400), falling
      // back to the requested spec version. Hardcoding a newer version here
      // would false-fail servers that negotiated an older one.
      const protocolVersion =
        (await negotiatedProtocolVersion(initResponse)) ?? specVersion;

      // Complete the handshake so the server treats the session as live.
      const initializedResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': protocolVersion,
          'mcp-session-id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }),
        signal: abort.signal
      });

      if (!initializedResponse.ok) {
        // The session never became live, so the termination checks would be
        // meaningless.
        checks.push(
          check(INITIALIZED_ACCEPTED, 'FAILURE', {
            errorMessage: `Expected 2xx for notifications/initialized, got ${initializedResponse.status}`,
            details: { statusCode: initializedResponse.status }
          }),
          skipped(
            DELETE_ACCEPTED,
            'Skipped because the initialized notification was rejected; the session never became live.'
          ),
          skipped(
            TERMINATED_RETURNS_404,
            'Skipped because the initialized notification was rejected; the session never became live.'
          )
        );
        return checks;
      }

      checks.push(
        check(INITIALIZED_ACCEPTED, 'SUCCESS', {
          details: { statusCode: initializedResponse.status }
        })
      );

      // Step 1: DELETE the session.
      const deleteResponse = await fetch(serverUrl, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sessionId,
          'MCP-Protocol-Version': protocolVersion
        },
        signal: abort.signal
      });

      const deleteAccepted =
        deleteResponse.status >= 200 && deleteResponse.status < 300;
      const deleteNotSupported = deleteResponse.status === 405;
      // A 404 could mean the server already considers the session terminated
      // (e.g. it expired between initialize and DELETE) — or that the server
      // simply has no DELETE route. The follow-up request below tells the
      // two apart.
      const deleteReturned404 = deleteResponse.status === 404;

      if (deleteNotSupported) {
        // If the server refused DELETE, the terminated-returns-404 check has
        // nothing to assert against.
        checks.push(
          check(DELETE_ACCEPTED, 'SKIPPED', {
            details: {
              statusCode: 405,
              message:
                'Server returned 405 Method Not Allowed; spec permits servers to refuse explicit DELETE.'
            }
          }),
          skipped(
            TERMINATED_RETURNS_404,
            'Skipped because the server does not support explicit session termination (405 on DELETE).'
          )
        );
        return checks;
      }

      if (!deleteAccepted && !deleteReturned404) {
        // The spec only says the client SHOULD send DELETE and the server
        // MAY respond 405; it never pins a success status, so an unexpected
        // status is diagnostic rather than a conformance failure. Without a confirmed
        // termination the terminated-returns-404 check would be misleading.
        const diagnosticMessage = `Expected 2xx, 404, or 405 for DELETE, got ${deleteResponse.status}. The spec does not pin a success status for session termination, so this is reported as diagnostic information.`;
        checks.push(
          check(DELETE_ACCEPTED, 'INFO', {
            details: {
              statusCode: deleteResponse.status,
              message: diagnosticMessage
            }
          }),
          skipped(
            TERMINATED_RETURNS_404,
            'Skipped because the preceding DELETE did not clearly terminate the session; cannot verify 404 behaviour.'
          )
        );
        return checks;
      }

      // Step 2: Re-send a request with the terminated session ID and expect 404.
      const afterTerminationResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': protocolVersion,
          'mcp-session-id': sessionId
        },
        body: JSON.stringify(TOOLS_LIST_BODY),
        signal: abort.signal
      });
      const terminated404 = afterTerminationResponse.status === 404;

      if (deleteReturned404 && !terminated404) {
        // The 404 on DELETE was not a termination: the session still
        // answers. Most likely the server has no DELETE route (it should
        // return 405 in that case).
        const diagnosticMessage = `DELETE returned 404 but the session still responds (HTTP ${afterTerminationResponse.status} on a follow-up request). The spec permits servers not to support explicit termination and does not require a particular response other than allowing 405.`;
        checks.push(
          check(DELETE_ACCEPTED, 'INFO', {
            details: { statusCode: 404, message: diagnosticMessage }
          }),
          skipped(
            TERMINATED_RETURNS_404,
            'Skipped because the preceding DELETE did not terminate the session; cannot verify 404 behaviour.'
          )
        );
        return checks;
      }

      checks.push(
        check(DELETE_ACCEPTED, 'SUCCESS', {
          details: deleteReturned404
            ? {
                statusCode: 404,
                message:
                  'Server returned 404 for DELETE and the session no longer responds; treating it as already terminated.'
              }
            : { statusCode: deleteResponse.status }
        })
      );

      if (terminated404) {
        checks.push(
          check(TERMINATED_RETURNS_404, 'SUCCESS', {
            details: { statusCode: 404 }
          })
        );
      } else {
        checks.push(
          check(TERMINATED_RETURNS_404, 'FAILURE', {
            errorMessage: `Expected 404 on terminated session ID, got ${afterTerminationResponse.status}`,
            details: { statusCode: afterTerminationResponse.status }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(LIFECYCLE_ERROR, 'FAILURE', {
          errorMessage: `Failed to exercise session lifecycle: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      );
    } finally {
      // Drop whatever is left of any response (e.g. a still-open SSE
      // stream after the negotiation timeout, or an unread follow-up body)
      // so it cannot keep the connection alive after the scenario ends. A
      // no-op for bodies that were fully consumed.
      abort.abort();
    }

    return checks;
  }
}

function skipped(def: CheckDef, message: string): ConformanceCheck {
  return check(def, 'SKIPPED', { details: { message } });
}
