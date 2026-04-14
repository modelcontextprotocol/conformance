/**
 * Server scenario: protocol version negotiation.
 *
 * MCP servers must negotiate a protocol version during the `initialize` exchange and
 * subsequently honor the agreed-upon version on every Streamable HTTP request via the
 * `MCP-Protocol-Version` header.
 *
 * This scenario exercises three independent invariants:
 *
 *   1. version-echo: when the client requests a version the server supports, the
 *      InitializeResult MUST echo the requested version verbatim.
 *
 *      Spec (2025-11-25, Lifecycle Sec.3.1):
 *        > If the server supports the requested protocol version, it MUST respond
 *        > with the same version. Otherwise, the server MUST respond with another
 *        > protocol version it supports.
 *
 *   2. version-negotiate: when the client requests an unsupported version
 *      (here `1999-01-01`), the server MUST respond with a different, valid
 *      protocol version (date-form, year >= 2025) -- NOT echo the unsupported value
 *      back, and NOT return a JSON-RPC error.
 *
 *   3. http-protocol-version-header: after a successful initialize, subsequent
 *      Streamable HTTP requests carrying the negotiated `MCP-Protocol-Version`
 *      header MUST be accepted by the server. We probe with a `ping` request,
 *      treating JSON-RPC `-32601 Method not found` as success because `ping` is
 *      optional in MCP -- a -32601 still confirms the server accepted the header and
 *      processed the envelope.
 *
 * Design note -- why raw fetch() instead of connectToServer():
 *   The TypeScript SDK's Client hard-codes the protocol version in every initialize
 *   request and provides no public API to override it. Version negotiation checks
 *   must control protocolVersion directly, so raw fetch() is the only viable approach.
 *
 * Design note -- why streaming SSE parsing:
 *   The MCP StreamableHTTP transport responds with text/event-stream for all POST
 *   requests, including initialize and ping, and keeps the connection open until the
 *   client disconnects. Calling response.text() on such a body blocks indefinitely.
 *   readFirstSSEMessage() reads incrementally, extracts the first data: line, then
 *   calls reader.cancel() in a finally block to close the underlying TCP connection
 *   cleanly without leaking unhandled errors.
 *
 * Each check runs in its own try/catch so a failure in one does not mask the others.
 * All session IDs allocated during the run are tracked in a single array and torn
 * down by an outer finally block via DELETE requests.
 *
 * @see https://github.com/modelcontextprotocol/conformance/issues/102
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#mcp-protocol-version-header
 */

import type {
  ClientScenario,
  ConformanceCheck,
  SpecVersion
} from '../../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The protocol version the harness identifies as "current" -- sent in check 1
 * (version-echo) and used as the MCP-Protocol-Version header value in check 3.
 */
const CURRENT_PROTOCOL_VERSION = '2025-11-25';

/**
 * A deliberately unsupported version sent in check 2 (version-negotiate).
 * Year 1999 predates the MCP spec, so isValidSpecVersion() (year < MIN_SPEC_YEAR)
 * will reject any server that echoes it back verbatim.
 */
const UNSUPPORTED_PROTOCOL_VERSION = '1999-01-01';

/**
 * Validates the date-string format used by every published MCP spec release.
 * All versions follow YYYY-MM-DD.
 */
const VERSION_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Earliest year a valid MCP protocol version may start with. */
const MIN_SPEC_YEAR = 2025;

/**
 * Spec versions this harness knows about. Used in version-negotiate to distinguish
 * between a known-good negotiated version (SUCCESS) and an unrecognized one (WARNING).
 * Update this set when the MCP spec ships a new release.
 */
const KNOWN_SPEC_VERSIONS: ReadonlySet<string> = new Set([
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
]);

/**
 * Default ceiling on how long we wait for the first SSE message to arrive.
 * Some servers accept the TCP connection but never write data; without a timeout
 * the test would hang indefinitely.
 */
const DEFAULT_SSE_READ_TIMEOUT_MS = 10_000;

/**
 * JSON-RPC error code for "method not found". MCP optional methods such as `ping`
 * may return this; a -32601 is not a transport- or header-level failure.
 */
const JSONRPC_METHOD_NOT_FOUND = -32601;

// ---------------------------------------------------------------------------
// Spec references
// ---------------------------------------------------------------------------

const SPEC_REF_LIFECYCLE = {
  id: 'lifecycle-version-negotiation',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation'
};

const SPEC_REF_TRANSPORT_HEADER = {
  id: 'transports-streamable-http-protocol-version-header',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#mcp-protocol-version-header'
};

// ---------------------------------------------------------------------------
// Check metadata -- factored out to avoid N-way repetition across success/failure
// branches while keeping the same check ID for all outcomes (AGENTS.md rule).
// ---------------------------------------------------------------------------

const CHECK_VERSION_ECHO = {
  id: 'version-echo',
  name: 'VersionEcho',
  description:
    `Server MUST respond with the same protocolVersion when client sends a supported ` +
    `version (${CURRENT_PROTOCOL_VERSION})`
};

const CHECK_VERSION_NEGOTIATE = {
  id: 'version-negotiate',
  name: 'VersionNegotiate',
  description:
    `Server MUST respond with a supported protocolVersion -- not a JSON-RPC error -- ` +
    `when client sends unsupported version "${UNSUPPORTED_PROTOCOL_VERSION}"`
};

const CHECK_HTTP_HEADER = {
  id: 'http-protocol-version-header',
  name: 'HttpProtocolVersionHeader',
  description:
    `Server MUST accept subsequent HTTP requests that include the ` +
    `"MCP-Protocol-Version: ${CURRENT_PROTOCOL_VERSION}" header`
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if version is a plausible MCP spec version string:
 *   - Matches YYYY-MM-DD format
 *   - Year >= MIN_SPEC_YEAR (2025)
 *
 * Intentionally accepts future unknown versions so the harness does not need
 * to be updated each time the spec ships a new release.
 * Intentionally rejects echoed-back invalid client versions (e.g. "1999-01-01").
 */
function isValidSpecVersion(version: string): boolean {
  if (!VERSION_DATE_REGEX.test(version)) return false;
  return parseInt(version.slice(0, 4), 10) >= MIN_SPEC_YEAR;
}

/**
 * Safe extraction of result.protocolVersion from a raw JSON-RPC response body.
 * Returns undefined rather than throwing if the field is absent or wrongly typed.
 */
function extractProtocolVersion(
  body: Record<string, unknown>
): string | undefined {
  const result = body.result;
  if (result === null || typeof result !== 'object') return undefined;
  const version = (result as Record<string, unknown>).protocolVersion;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Returns true if the response body carries a JSON-RPC error object whose `code`
 * matches the supplied numeric value.
 */
function isJsonRpcError(body: Record<string, unknown>, code: number): boolean {
  const err = body.error;
  if (err === null || typeof err !== 'object') return false;
  const errCode = (err as Record<string, unknown>).code;
  return typeof errCode === 'number' && errCode === code;
}

/** Coerce an unknown thrown value into a human-readable string. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// SSE / HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Read a text/event-stream body until the first parseable JSON-RPC object
 * appears on a data: line, then cancel the reader to close the connection.
 *
 * Key design points:
 *  - The MCP StreamableHTTP transport keeps the SSE connection open until the
 *    client disconnects. response.text() blocks indefinitely on such a stream.
 *  - A single timeout is created BEFORE the read loop and measures total elapsed
 *    time -- not per-chunk time -- so a server that trickles data cannot defeat it.
 *  - reader.cancel() is called in the finally block (not releaseLock) so the
 *    underlying TCP connection is actually closed rather than just unlocked.
 *  - Line splitting accepts both \n and \r\n per the SSE specification.
 *  - Multi-line SSE events (multiple data: lines before the blank-line delimiter)
 *    are joined with \n before JSON.parse(), matching the SSE spec.
 *
 * @param body     ReadableStream from a fetch Response (response.body).
 * @param timeoutMs  Maximum milliseconds to wait for the first message (default 10 s).
 * @returns The first parseable JSON-RPC message, or { __parseError: <reason> }.
 */
async function readFirstSSEMessage(
  body: ReadableStream<Uint8Array> | null,
  timeoutMs: number = DEFAULT_SSE_READ_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  if (body === null) {
    return { __parseError: 'response body was null' };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';

  // Create the timeout sentinel ONCE, before the read loop, so it measures the
  // total wait across all chunks -- not just the time for the current chunk.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutSentinel = new Promise<{ __timeout: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });

  try {
    while (true) {
      // Race the next chunk against the single shared timeout.
      const settled = await Promise.race([reader.read(), timeoutSentinel]);

      if ('__timeout' in settled) {
        return {
          __parseError: `timed out after ${timeoutMs}ms waiting for SSE data`
        };
      }

      // TypeScript knows settled is ReadableStreamReadResult<Uint8Array> here.
      if (settled.value !== undefined) {
        lineBuffer += decoder.decode(settled.value, { stream: true });
      }

      // SSE lines may be terminated by \n or \r\n (per SSE spec Sec.8.1).
      const lines = lineBuffer.split(/\r\n|\n/);
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        // SSE data lines start with "data:" -- skip non-data lines (event:, id:, retry:, comments).
        if (!line.startsWith('data:')) continue;

        const json = line.slice('data:'.length).trim();

        // Empty data lines are keep-alive heartbeats -- skip.
        if (!json.startsWith('{')) continue;

        try {
          return JSON.parse(json) as Record<string, unknown>;
        } catch {
          // Malformed JSON on this line -- keep scanning subsequent events.
        }
      }

      if (settled.done) {
        return { __parseError: 'no parseable JSON-RPC message in SSE stream' };
      }
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // reader.cancel() closes the underlying source (the TCP connection) and
    // implicitly releases the lock. releaseLock() alone would leave the connection
    // open until GC.
    try {
      await reader.cancel();
    } catch {
      // Expected when the stream is already closed -- safe to ignore.
    }
  }
}

/**
 * Send a raw JSON-RPC POST to the MCP server over Streamable HTTP.
 * Returns the raw Response so callers can inspect status, headers, and body.
 */
async function sendRawMCPRequest(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // MCP StreamableHTTP requires the client to advertise both content types.
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

/**
 * Build a minimal JSON-RPC 2.0 initialize request with a caller-controlled
 * protocolVersion. Only required fields are included to avoid triggering
 * unrelated capability-negotiation code paths in the server under test.
 */
function buildInitializeRequest(
  version: string,
  id: number
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: {
        name: 'mcp-conformance-version-test',
        version: '1.0.0'
      }
    }
  };
}

/**
 * Best-effort session teardown via DELETE /mcp.
 * Errors are silently swallowed -- cleanup runs in a finally block and must not
 * mask the real test outcome.
 */
async function deleteSession(url: string, sessionId: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    });
  } catch {
    /* intentionally ignored */
  }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export class ServerVersionNegotiationScenario implements ClientScenario {
  public readonly name = 'server-version-negotiation';
  // All checks send/expect CURRENT_PROTOCOL_VERSION (2025-11-25). Listing older
  // versions would cause false FAILUREs on servers that only implement those versions.
  public readonly specVersions: SpecVersion[] = ['2025-11-25'];
  public readonly description = `Test protocol version negotiation during MCP initialization.

**Server Implementation Requirements:**

**Lifecycle Phase**: \`initialize\`

**Requirements (Streamable HTTP transport)**:
- Server **MUST** respond with the same \`protocolVersion\` when the client sends a version the server supports (\`version-echo\`).
- Server **MUST** respond with a supported \`protocolVersion\` -- **not a JSON-RPC error** -- when the client sends an unsupported version (\`version-negotiate\`). The server SHOULD respond with its latest supported version.
- Server **MUST** accept subsequent HTTP requests that include the \`MCP-Protocol-Version\` HTTP header set to the negotiated protocol version (\`http-protocol-version-header\`).

**Example -- supported version echoed (${CURRENT_PROTOCOL_VERSION} -> ${CURRENT_PROTOCOL_VERSION}):**
\`\`\`json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "${CURRENT_PROTOCOL_VERSION}", "capabilities": {}, "clientInfo": {...} } }

// Response -- server MUST echo the same version
{ "jsonrpc": "2.0", "id": 1,
  "result": { "protocolVersion": "${CURRENT_PROTOCOL_VERSION}", "capabilities": {...}, "serverInfo": {...} } }
\`\`\`

**Example -- unsupported version negotiated (${UNSUPPORTED_PROTOCOL_VERSION} -> ${CURRENT_PROTOCOL_VERSION}):**
\`\`\`json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "${UNSUPPORTED_PROTOCOL_VERSION}", "capabilities": {}, "clientInfo": {...} } }

// Response -- server MUST reply with a version it supports, NOT a JSON-RPC error
{ "jsonrpc": "2.0", "id": 1,
  "result": { "protocolVersion": "${CURRENT_PROTOCOL_VERSION}", "capabilities": {...}, "serverInfo": {...} } }
\`\`\``;

  public async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const ts = () => new Date().toISOString();

    // All session IDs minted during this run. Cleaned up in the outer finally
    // block regardless of which checks succeed or fail, preventing orphaned
    // sessions from accumulating in the test server.
    const sessionsToClear: string[] = [];

    // Set to true if check 1 throws a transport error (network down, connection
    // refused, etc.). When true, check 3 is reported as SKIPPED rather than
    // running with no real session, which would produce a misleading FAILURE.
    let check1Threw = false;

    // Session ID captured from check 1. Reused in check 3 to avoid a redundant
    // initialize round-trip. Undefined for stateless servers.
    let sessionFromEcho: string | undefined;

    // protocolVersion the server returned in check 1. Used as the
    // MCP-Protocol-Version header value in check 3 so that the header matches
    // what was actually negotiated -- not a hardcoded constant that may differ
    // from what the server supports.
    let negotiatedVersion: string | undefined;

    try {
      // -----------------------------------------------------------------------
      // Check 1: version-echo
      //
      // Spec Sec.3.1: "If the server supports the requested protocol version, it
      // MUST respond with the same version."
      //
      // Send initialize with the current supported version and verify the
      // InitializeResult echoes exactly the same version string back.
      // -----------------------------------------------------------------------
      try {
        const response = await sendRawMCPRequest(
          serverUrl,
          buildInitializeRequest(CURRENT_PROTOCOL_VERSION, 1)
        );

        const sid = response.headers.get('mcp-session-id') ?? undefined;
        if (sid !== undefined) {
          sessionsToClear.push(sid);
          sessionFromEcho = sid;
        }

        const jsonrpcBody = await readFirstSSEMessage(response.body);

        if (jsonrpcBody.__parseError !== undefined) {
          // The stream closed or timed out before yielding a parseable message.
          checks.push({
            ...CHECK_VERSION_ECHO,
            status: 'FAILURE',
            timestamp: ts(),
            errorMessage: `Server response could not be parsed: ${String(jsonrpcBody.__parseError)}`,
            specReferences: [SPEC_REF_LIFECYCLE],
            details: {
              sentVersion: CURRENT_PROTOCOL_VERSION,
              httpStatus: response.status
            }
          });
        } else if (jsonrpcBody.error !== undefined) {
          // A JSON-RPC error at the initialize level is itself a protocol violation.
          checks.push({
            ...CHECK_VERSION_ECHO,
            status: 'FAILURE',
            timestamp: ts(),
            errorMessage: `Server returned a JSON-RPC error instead of an InitializeResult: ${JSON.stringify(jsonrpcBody.error)}`,
            specReferences: [SPEC_REF_LIFECYCLE],
            details: {
              sentVersion: CURRENT_PROTOCOL_VERSION,
              error: jsonrpcBody.error
            }
          });
        } else {
          const serverVersion = extractProtocolVersion(jsonrpcBody);

          if (serverVersion === undefined) {
            checks.push({
              ...CHECK_VERSION_ECHO,
              status: 'FAILURE',
              timestamp: ts(),
              errorMessage:
                'InitializeResult is missing the required protocolVersion field',
              specReferences: [SPEC_REF_LIFECYCLE],
              details: { sentVersion: CURRENT_PROTOCOL_VERSION }
            });
          } else if (serverVersion !== CURRENT_PROTOCOL_VERSION) {
            // Still capture the version so check 3 sends the correct header
            // even when check 1 fails (server may accept its own returned version).
            negotiatedVersion = serverVersion;
            checks.push({
              ...CHECK_VERSION_ECHO,
              status: 'FAILURE',
              timestamp: ts(),
              errorMessage:
                `Expected protocolVersion "${CURRENT_PROTOCOL_VERSION}" but server responded ` +
                `with "${serverVersion}"`,
              specReferences: [SPEC_REF_LIFECYCLE],
              details: {
                sentVersion: CURRENT_PROTOCOL_VERSION,
                receivedVersion: serverVersion
              }
            });
          } else {
            negotiatedVersion = serverVersion;
            checks.push({
              ...CHECK_VERSION_ECHO,
              status: 'SUCCESS',
              timestamp: ts(),
              specReferences: [SPEC_REF_LIFECYCLE],
              details: {
                sentVersion: CURRENT_PROTOCOL_VERSION,
                receivedVersion: serverVersion
              }
            });
          }
        }
      } catch (err) {
        check1Threw = true;
        checks.push({
          ...CHECK_VERSION_ECHO,
          status: 'FAILURE',
          timestamp: ts(),
          errorMessage: `Network or transport error during initialize: ${errMessage(err)}`,
          specReferences: [SPEC_REF_LIFECYCLE]
        });
      }

      // -----------------------------------------------------------------------
      // Check 2: version-negotiate
      //
      // Spec Sec.3.1: "Otherwise, the server MUST respond with another protocol
      // version it supports." (The server SHOULD respond with its latest version.)
      //
      // Send initialize with a deliberately unsupported version and verify the
      // server responds with a valid known-format version -- not a JSON-RPC error
      // and not an echo of the invalid client version.
      //
      // This check runs independently of check 1 so a failure in check 1 does
      // not cascade here. The session opened for this check is tracked in
      // sessionsToClear and deleted by the outer finally block.
      // -----------------------------------------------------------------------
      try {
        const response = await sendRawMCPRequest(
          serverUrl,
          buildInitializeRequest(UNSUPPORTED_PROTOCOL_VERSION, 2)
        );

        const sid = response.headers.get('mcp-session-id') ?? undefined;
        if (sid !== undefined) {
          sessionsToClear.push(sid);
        }

        const jsonrpcBody = await readFirstSSEMessage(response.body);

        if (jsonrpcBody.__parseError !== undefined) {
          checks.push({
            ...CHECK_VERSION_NEGOTIATE,
            status: 'FAILURE',
            timestamp: ts(),
            errorMessage: `Server response could not be parsed: ${String(jsonrpcBody.__parseError)}`,
            specReferences: [SPEC_REF_LIFECYCLE],
            details: {
              sentVersion: UNSUPPORTED_PROTOCOL_VERSION,
              httpStatus: response.status
            }
          });
        } else if (jsonrpcBody.error !== undefined) {
          // Server rejected the initialize with an error instead of negotiating.
          // This directly violates the MUST requirement.
          checks.push({
            ...CHECK_VERSION_NEGOTIATE,
            status: 'FAILURE',
            timestamp: ts(),
            errorMessage:
              'Server returned a JSON-RPC error instead of negotiating a supported version. ' +
              'Spec requires the server to respond with another supported version, not an error.',
            specReferences: [SPEC_REF_LIFECYCLE],
            details: {
              sentVersion: UNSUPPORTED_PROTOCOL_VERSION,
              error: jsonrpcBody.error
            }
          });
        } else {
          const serverVersion = extractProtocolVersion(jsonrpcBody);

          if (serverVersion === undefined) {
            checks.push({
              ...CHECK_VERSION_NEGOTIATE,
              status: 'FAILURE',
              timestamp: ts(),
              errorMessage:
                'InitializeResult is missing the required protocolVersion field',
              specReferences: [SPEC_REF_LIFECYCLE],
              details: { sentVersion: UNSUPPORTED_PROTOCOL_VERSION }
            });
          } else if (!isValidSpecVersion(serverVersion)) {
            // Catches echo-back of the invalid client version (year < MIN_SPEC_YEAR)
            // and any non-date-format string.
            checks.push({
              ...CHECK_VERSION_NEGOTIATE,
              status: 'FAILURE',
              timestamp: ts(),
              errorMessage:
                `Server responded with protocolVersion "${serverVersion}" which is not a ` +
                `valid spec version (must be YYYY-MM-DD with year >= ${MIN_SPEC_YEAR}). ` +
                `The server appears to have echoed the unsupported client version or ` +
                `returned a malformed value.`,
              specReferences: [SPEC_REF_LIFECYCLE],
              details: {
                sentVersion: UNSUPPORTED_PROTOCOL_VERSION,
                receivedVersion: serverVersion
              }
            });
          } else if (!KNOWN_SPEC_VERSIONS.has(serverVersion)) {
            // Valid date format and year, but not a spec version this harness
            // recognises. Could be a new spec release; update KNOWN_SPEC_VERSIONS
            // to verify conformance fully. Reported as WARNING, not FAILURE, so
            // servers running new specs are not incorrectly blocked.
            checks.push({
              ...CHECK_VERSION_NEGOTIATE,
              status: 'WARNING',
              timestamp: ts(),
              errorMessage:
                `Server negotiated version "${serverVersion}" which is not a known spec ` +
                `release (known: ${Array.from(KNOWN_SPEC_VERSIONS).join(', ')}). ` +
                `If this is a new MCP spec version, add it to KNOWN_SPEC_VERSIONS in the harness.`,
              specReferences: [SPEC_REF_LIFECYCLE],
              details: {
                sentVersion: UNSUPPORTED_PROTOCOL_VERSION,
                receivedVersion: serverVersion,
                knownVersions: Array.from(KNOWN_SPEC_VERSIONS)
              }
            });
          } else {
            checks.push({
              ...CHECK_VERSION_NEGOTIATE,
              status: 'SUCCESS',
              timestamp: ts(),
              specReferences: [SPEC_REF_LIFECYCLE],
              details: {
                sentVersion: UNSUPPORTED_PROTOCOL_VERSION,
                receivedVersion: serverVersion
              }
            });
          }
        }
      } catch (err) {
        checks.push({
          ...CHECK_VERSION_NEGOTIATE,
          status: 'FAILURE',
          timestamp: ts(),
          errorMessage: `Network or transport error during version-negotiate test: ${errMessage(err)}`,
          specReferences: [SPEC_REF_LIFECYCLE]
        });
      }

      // -----------------------------------------------------------------------
      // Check 3: http-protocol-version-header
      //
      // Spec Sec.2.3: "If using HTTP, the client MUST include the
      // MCP-Protocol-Version: <protocol-version> HTTP header on all subsequent
      // requests to the MCP server."
      //
      // We act as a spec-compliant client and include the header on a ping
      // request. The check verifies the server returns a 2xx response -- a 4xx
      // or 5xx would indicate the server is incorrectly rejecting the header.
      //
      // JSON-RPC -32601 (Method Not Found) is treated as SUCCESS because `ping`
      // is optional; a -32601 confirms the server accepted the request and
      // processed the JSON-RPC envelope -- it just doesn't implement ping.
      //
      // If check 1 threw a transport error (server unreachable), this check is
      // reported as SKIPPED because there is no real session to probe against.
      // If check 1 merely failed with a FAILURE status (server responded with
      // wrong version), this check still runs because the server is functioning.
      //
      // The session from check 1 (if any) is reused here to avoid a redundant
      // initialize round-trip. For stateless servers that issue no session IDs,
      // the ping is sent without an mcp-session-id header.
      // -----------------------------------------------------------------------
      if (check1Threw) {
        checks.push({
          ...CHECK_HTTP_HEADER,
          status: 'SKIPPED',
          timestamp: ts(),
          errorMessage:
            'Skipped: version-echo threw a transport error so no server session is ' +
            'available to probe with the MCP-Protocol-Version header.',
          specReferences: [SPEC_REF_TRANSPORT_HEADER]
        });
      } else {
        try {
          // Use the version the server actually returned in check 1, falling back
          // to CURRENT_PROTOCOL_VERSION only when check 1 could not extract any
          // version (parse error, JSON-RPC error, missing field).
          const headerVersion = negotiatedVersion ?? CURRENT_PROTOCOL_VERSION;
          const pingHeaders: Record<string, string> = {
            'MCP-Protocol-Version': headerVersion
          };
          if (sessionFromEcho !== undefined) {
            pingHeaders['mcp-session-id'] = sessionFromEcho;
          }

          const pingResponse = await sendRawMCPRequest(
            serverUrl,
            { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
            pingHeaders
          );

          const httpStatus = pingResponse.status;
          const jsonrpcBody = await readFirstSSEMessage(pingResponse.body);

          if (httpStatus >= 400) {
            // Server rejected a compliant subsequent request carrying the required
            // MCP-Protocol-Version header.
            checks.push({
              ...CHECK_HTTP_HEADER,
              status: 'FAILURE',
              timestamp: ts(),
              errorMessage:
                `Server returned HTTP ${httpStatus} for a ping request carrying the ` +
                `MCP-Protocol-Version: ${headerVersion} header.`,
              specReferences: [SPEC_REF_TRANSPORT_HEADER],
              details: {
                sentHeaderValue: headerVersion,
                httpStatus
              }
            });
          } else if (isJsonRpcError(jsonrpcBody, JSONRPC_METHOD_NOT_FOUND)) {
            // ping is optional; -32601 means the server accepted and processed the
            // request -- the header was not the cause of the error.
            checks.push({
              ...CHECK_HTTP_HEADER,
              status: 'SUCCESS',
              timestamp: ts(),
              specReferences: [SPEC_REF_TRANSPORT_HEADER],
              details: {
                sentHeaderValue: headerVersion,
                httpStatus,
                note: 'ping returned -32601 (method not found) -- header accepted, ping is optional in MCP'
              }
            });
          } else if (jsonrpcBody.error !== undefined) {
            // Some other JSON-RPC error: we cannot determine whether the header
            // triggered it. Report as WARNING so tooling can flag it without
            // blocking the overall result.
            checks.push({
              ...CHECK_HTTP_HEADER,
              status: 'WARNING',
              timestamp: ts(),
              errorMessage:
                `Server returned JSON-RPC error ${JSON.stringify(jsonrpcBody.error)} -- ` +
                `cannot determine if the MCP-Protocol-Version header was the cause.`,
              specReferences: [SPEC_REF_TRANSPORT_HEADER],
              details: {
                sentHeaderValue: headerVersion,
                httpStatus,
                error: jsonrpcBody.error
              }
            });
          } else if (jsonrpcBody.__parseError !== undefined) {
            // 2xx but unparseable body. Unlikely for ping; reported as WARNING.
            checks.push({
              ...CHECK_HTTP_HEADER,
              status: 'WARNING',
              timestamp: ts(),
              errorMessage:
                `Server returned HTTP ${httpStatus} but the response body could not ` +
                `be parsed: ${String(jsonrpcBody.__parseError)}`,
              specReferences: [SPEC_REF_TRANSPORT_HEADER],
              details: {
                sentHeaderValue: headerVersion,
                httpStatus
              }
            });
          } else {
            checks.push({
              ...CHECK_HTTP_HEADER,
              status: 'SUCCESS',
              timestamp: ts(),
              specReferences: [SPEC_REF_TRANSPORT_HEADER],
              details: {
                sentHeaderValue: headerVersion,
                httpStatus
              }
            });
          }
        } catch (err) {
          checks.push({
            ...CHECK_HTTP_HEADER,
            status: 'FAILURE',
            timestamp: ts(),
            errorMessage: `Network or transport error during header check: ${errMessage(err)}`,
            specReferences: [SPEC_REF_TRANSPORT_HEADER]
          });
        }
      }
    } finally {
      // Best-effort cleanup of every session minted during this run.
      // Promise.allSettled ensures one failed DELETE cannot block others.
      await Promise.allSettled(
        sessionsToClear.map((id) => deleteSession(serverUrl, id))
      );
    }

    return checks;
  }
}
