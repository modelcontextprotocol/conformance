import type {
  ClientScenario,
  ConformanceCheck,
  SpecReference
} from '../../types';
import type { SpecVersion } from '../../types';
import type { RunContext } from '../../connection';
import {
  buildStandardHeaders,
  readSseJsonRpcResponse,
  withRequestMeta,
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_CLIENT_CAPABILITIES,
  type JsonRpcResponse
} from '../../connection';
import { isStateless } from '../../connection/select';
import { validateWireMessage } from '../../validation/wire-schema';

// Trace: the probes below are the wire-level half of the reject vectors
// `a8-error-response-has-no-preimage` and `a4-duplicate-member` in the
// agent-evidence-vectors corpus (vectors-ai-agent-action/attacks), which
// treat a JSON-RPC error frame and the id it carries as the only evidence a
// failed tools/call leaves behind.

const SPEC_TOOLS_ERROR_HANDLING: SpecReference = {
  id: 'MCP-Tools-Error-Handling',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling'
};
const SPEC_ERROR_RESPONSES: SpecReference = {
  id: 'MCP-Error-Responses',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#error-responses'
};
const SPEC_RESULT_RESPONSES: SpecReference = {
  id: 'MCP-Result-Responses',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic#result-responses'
};
const SPEC_JSONRPC_RESPONSE: SpecReference = {
  id: 'JSON-RPC-2.0-Response',
  url: 'https://www.jsonrpc.org/specification#response_object'
};

const NUMERIC_PROBE_ID = 4242;
const STRING_PROBE_ID = 'conformance-unknown-tool-probe';
const STRING_LIST_ID = 'conformance-tools-list-probe';
const UNKNOWN_TOOL_NAME = 'conformance_tool_that_does_not_exist';
const REQUEST_TIMEOUT_MS = 10000;

interface RawFrame {
  status: number;
  frame?: JsonRpcResponse;
  rawBody?: string;
}

/**
 * Minimal session for the dated (stateful) wire: a raw initialize followed by
 * notifications/initialized. Returns the session id header, if any. The
 * stateless draft wire needs no handshake and returns undefined.
 */
async function openSession(
  serverUrl: string,
  specVersion: SpecVersion
): Promise<{ sessionId?: string }> {
  if (isStateless({ specVersion })) return {};
  const initRes = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': specVersion
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: specVersion,
        capabilities: DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: CONFORMANCE_CLIENT_INFO
      }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
  // Drain the initialize body so the connection is released.
  if (
    (initRes.headers.get('content-type') ?? '').includes('text/event-stream')
  ) {
    await readSseJsonRpcResponse(initRes, 1);
  } else {
    await initRes.text();
  }
  if (initRes.status >= 400) {
    throw new Error(`initialize returned HTTP ${initRes.status}`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': specVersion
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const notifyRes = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  await notifyRes.text();
  return { sessionId };
}

/**
 * POST one JSON-RPC request with a caller-chosen id and return the response
 * frame exactly as the server sent it. The shared connection layer picks its
 * own numeric ids and throws on error frames, and this scenario needs to see
 * both the id and the error frame as bytes on the wire.
 */
async function sendRaw(
  serverUrl: string,
  specVersion: SpecVersion,
  sessionId: string | undefined,
  id: number | string,
  method: string,
  params: Record<string, unknown>
): Promise<RawFrame> {
  const stateless = isStateless({ specVersion });
  const headers = stateless
    ? buildStandardHeaders(method, params, { specVersion })
    : {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': specVersion,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      };
  const request = {
    jsonrpc: '2.0',
    id,
    method,
    params: stateless ? withRequestMeta(params, specVersion) : params
  };
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const { events, body } = await readSseJsonRpcResponse(res, id);
    for (const event of events) {
      validateWireMessage(specVersion, event, {
        origin: 'implementation',
        context: `SSE event during '${method}' (tools-call-protocol-error)`,
        requestMethod: event === body ? method : undefined
      });
    }
    return { status: res.status, frame: body };
  }
  const text = await res.text();
  if (!text) return { status: res.status, rawBody: text };
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse;
    validateWireMessage(specVersion, parsed, {
      origin: 'implementation',
      context: `response to '${method}' (tools-call-protocol-error)`,
      requestMethod: method
    });
    return { status: res.status, frame: parsed, rawBody: text };
  } catch {
    return { status: res.status, rawBody: text };
  }
}

function describeId(id: unknown): string {
  return `${JSON.stringify(id)} (${id === null ? 'null' : typeof id})`;
}

export class ToolsCallProtocolErrorScenario implements ClientScenario {
  name = 'tools-call-protocol-error';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test that a tools/call for a tool the server does not have is answered with a JSON-RPC error response whose frame is well formed and correlated to the request.

**Server Implementation Requirements:**

No fixture tool is needed. The scenario calls a tool name that must NOT exist (\`${UNKNOWN_TOOL_NAME}\`), once with a numeric request id and once with a string request id, and then calls \`tools/list\` with a string request id.

**Behavior**: An unknown tool is a protocol error, not a tool execution error. The server answers with a JSON-RPC error response (an \`error\` member and no \`result\`), not with a \`CallToolResult\` carrying \`isError: true\`.

**Checks** (spec keyword in parentheses):
- \`tools-call-unknown-tool-protocol-error\`: the response is an error frame, not an \`isError\` result (Tools > Error Handling: unknown tools are protocol errors)
- \`tools-call-unknown-tool-error-code\`: \`error.code\` is \`-32602\`, the code the specification's own example uses (SHOULD-level, WARNING)
- \`jsonrpc-error-code-integer\`: \`error.code\` is an integer (MUST)
- \`jsonrpc-error-message-string\`: \`error.message\` is a string (MUST)
- \`jsonrpc-error-response-no-result\`: an error response carries no \`result\` member (JSON-RPC 2.0 MUST NOT)
- \`jsonrpc-error-response-id-matches\`: the error response echoes the numeric request id exactly (MUST)
- \`jsonrpc-error-response-id-string-preserved\`: a string request id comes back as the same string, not coerced to a number (MUST)
- \`jsonrpc-result-response-id-string-preserved\`: the \`tools/list\` result echoes a string request id as the same string (MUST)`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const { serverUrl, specVersion } = ctx;
    const now = () => new Date().toISOString();

    const fail = (
      id: string,
      name: string,
      description: string,
      errorMessage: string,
      specReferences: SpecReference[],
      details?: Record<string, unknown>,
      status: 'FAILURE' | 'WARNING' = 'FAILURE'
    ): ConformanceCheck => ({
      id,
      name,
      description,
      status,
      timestamp: now(),
      errorMessage,
      specReferences,
      details
    });
    const pass = (
      id: string,
      name: string,
      description: string,
      specReferences: SpecReference[],
      details?: Record<string, unknown>
    ): ConformanceCheck => ({
      id,
      name,
      description,
      status: 'SUCCESS',
      timestamp: now(),
      specReferences,
      details
    });

    let sessionId: string | undefined;
    try {
      ({ sessionId } = await openSession(serverUrl, specVersion));
    } catch (error) {
      const message = `Could not open a session: ${error instanceof Error ? error.message : String(error)}`;
      for (const [id, name, description] of CHECK_DEFS) {
        checks.push(
          fail(id, name, description, message, [SPEC_ERROR_RESPONSES])
        );
      }
      return checks;
    }

    // Probe 1: unknown tool, numeric id.
    let numeric: RawFrame;
    try {
      numeric = await sendRaw(
        serverUrl,
        specVersion,
        sessionId,
        NUMERIC_PROBE_ID,
        'tools/call',
        { name: UNKNOWN_TOOL_NAME, arguments: {} }
      );
    } catch (error) {
      numeric = {
        status: 0,
        rawBody: `request failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const frame = numeric.frame;
    const frameDetails = {
      httpStatus: numeric.status,
      response: frame ?? numeric.rawBody
    };

    const isErrorFrame = frame !== undefined && 'error' in frame;
    const isErrorResult =
      frame !== undefined &&
      'result' in frame &&
      (frame.result as { isError?: unknown } | undefined)?.isError === true;

    checks.push(
      isErrorFrame
        ? pass(
            'tools-call-unknown-tool-protocol-error',
            'ToolsCallUnknownToolProtocolError',
            'Calling a tool the server does not have yields a JSON-RPC error response',
            [SPEC_TOOLS_ERROR_HANDLING],
            frameDetails
          )
        : fail(
            'tools-call-unknown-tool-protocol-error',
            'ToolsCallUnknownToolProtocolError',
            'Calling a tool the server does not have yields a JSON-RPC error response',
            frame === undefined
              ? `No JSON-RPC response frame was returned (HTTP ${numeric.status})`
              : isErrorResult
                ? 'Unknown tool was reported as a tool execution error (result.isError: true) instead of a JSON-RPC protocol error'
                : 'Unknown tool was answered with a result instead of a JSON-RPC error response',
            [SPEC_TOOLS_ERROR_HANDLING],
            frameDetails
          )
    );

    const err = isErrorFrame
      ? (frame.error as { code?: unknown; message?: unknown })
      : undefined;
    const errorFramePrereq = isErrorFrame
      ? undefined
      : 'Not testable: the server did not return a JSON-RPC error response for the unknown tool';

    checks.push(
      err?.code === -32602
        ? pass(
            'tools-call-unknown-tool-error-code',
            'ToolsCallUnknownToolErrorCode',
            'Unknown tool error uses code -32602 (Invalid params), as in the specification example',
            [SPEC_TOOLS_ERROR_HANDLING],
            frameDetails
          )
        : fail(
            'tools-call-unknown-tool-error-code',
            'ToolsCallUnknownToolErrorCode',
            'Unknown tool error uses code -32602 (Invalid params), as in the specification example',
            errorFramePrereq ??
              `Expected error.code -32602, got ${JSON.stringify(err?.code)}`,
            [SPEC_TOOLS_ERROR_HANDLING],
            frameDetails,
            'WARNING'
          )
    );

    checks.push(
      err !== undefined && Number.isInteger(err.code)
        ? pass(
            'jsonrpc-error-code-integer',
            'JsonRpcErrorCodeInteger',
            'Error codes MUST be integers',
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
        : fail(
            'jsonrpc-error-code-integer',
            'JsonRpcErrorCodeInteger',
            'Error codes MUST be integers',
            errorFramePrereq ??
              `error.code is ${JSON.stringify(err?.code)}, not an integer`,
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
    );

    checks.push(
      err !== undefined && typeof err.message === 'string'
        ? pass(
            'jsonrpc-error-message-string',
            'JsonRpcErrorMessageString',
            'Error responses MUST include an error field with a code and message',
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
        : fail(
            'jsonrpc-error-message-string',
            'JsonRpcErrorMessageString',
            'Error responses MUST include an error field with a code and message',
            errorFramePrereq ??
              `error.message is ${JSON.stringify(err?.message)}, not a string`,
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
    );

    checks.push(
      isErrorFrame && !('result' in frame)
        ? pass(
            'jsonrpc-error-response-no-result',
            'JsonRpcErrorResponseNoResult',
            'An error response carries no result member',
            [SPEC_JSONRPC_RESPONSE, SPEC_ERROR_RESPONSES],
            frameDetails
          )
        : fail(
            'jsonrpc-error-response-no-result',
            'JsonRpcErrorResponseNoResult',
            'An error response carries no result member',
            errorFramePrereq ??
              'Error response carries both error and result members',
            [SPEC_JSONRPC_RESPONSE, SPEC_ERROR_RESPONSES],
            frameDetails
          )
    );

    checks.push(
      isErrorFrame && frame.id === NUMERIC_PROBE_ID
        ? pass(
            'jsonrpc-error-response-id-matches',
            'JsonRpcErrorResponseIdMatches',
            'Error responses MUST include the same ID as the request they correspond to',
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
        : fail(
            'jsonrpc-error-response-id-matches',
            'JsonRpcErrorResponseIdMatches',
            'Error responses MUST include the same ID as the request they correspond to',
            errorFramePrereq ??
              `Request id was ${describeId(NUMERIC_PROBE_ID)}, response id is ${describeId(frame?.id)}`,
            [SPEC_ERROR_RESPONSES],
            frameDetails
          )
    );

    // Probe 2: unknown tool, string id. Exercises the id type, which a server
    // that parses ids as numbers or stringifies them silently breaks.
    let stringProbe: RawFrame;
    try {
      stringProbe = await sendRaw(
        serverUrl,
        specVersion,
        sessionId,
        STRING_PROBE_ID,
        'tools/call',
        { name: UNKNOWN_TOOL_NAME, arguments: {} }
      );
    } catch (error) {
      stringProbe = {
        status: 0,
        rawBody: `request failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const sFrame = stringProbe.frame;
    const sDetails = {
      httpStatus: stringProbe.status,
      response: sFrame ?? stringProbe.rawBody
    };
    checks.push(
      sFrame !== undefined && 'error' in sFrame && sFrame.id === STRING_PROBE_ID
        ? pass(
            'jsonrpc-error-response-id-string-preserved',
            'JsonRpcErrorResponseIdStringPreserved',
            'A string request id is echoed on the error response as the same string',
            [SPEC_ERROR_RESPONSES],
            sDetails
          )
        : fail(
            'jsonrpc-error-response-id-string-preserved',
            'JsonRpcErrorResponseIdStringPreserved',
            'A string request id is echoed on the error response as the same string',
            sFrame === undefined
              ? `No JSON-RPC response frame was returned (HTTP ${stringProbe.status})`
              : !('error' in sFrame)
                ? 'Not testable: the server did not return a JSON-RPC error response for the unknown tool'
                : `Request id was ${describeId(STRING_PROBE_ID)}, response id is ${describeId(sFrame.id)}`,
            [SPEC_ERROR_RESPONSES],
            sDetails
          )
    );

    // Probe 3: a valid request with a string id, so the id rule is checked on
    // the result path too and not only on the error path.
    let listProbe: RawFrame;
    try {
      listProbe = await sendRaw(
        serverUrl,
        specVersion,
        sessionId,
        STRING_LIST_ID,
        'tools/list',
        {}
      );
    } catch (error) {
      listProbe = {
        status: 0,
        rawBody: `request failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const lFrame = listProbe.frame;
    const lDetails = {
      httpStatus: listProbe.status,
      response: lFrame ?? listProbe.rawBody
    };
    checks.push(
      lFrame !== undefined && 'result' in lFrame && lFrame.id === STRING_LIST_ID
        ? pass(
            'jsonrpc-result-response-id-string-preserved',
            'JsonRpcResultResponseIdStringPreserved',
            'Result responses MUST include the same ID as the request they correspond to, including a string id',
            [SPEC_RESULT_RESPONSES],
            lDetails
          )
        : fail(
            'jsonrpc-result-response-id-string-preserved',
            'JsonRpcResultResponseIdStringPreserved',
            'Result responses MUST include the same ID as the request they correspond to, including a string id',
            lFrame === undefined
              ? `No JSON-RPC response frame was returned (HTTP ${listProbe.status})`
              : !('result' in lFrame)
                ? `tools/list with a string id was answered with an error: ${JSON.stringify(lFrame.error)}`
                : `Request id was ${describeId(STRING_LIST_ID)}, response id is ${describeId(lFrame.id)}`,
            [SPEC_RESULT_RESPONSES],
            lDetails
          )
    );

    if (sessionId && !isStateless({ specVersion })) {
      try {
        await fetch(serverUrl, {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': sessionId,
            'MCP-Protocol-Version': specVersion
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {
        // Session cleanup is best-effort; the checks above already ran.
      }
    }

    return checks;
  }
}

const CHECK_DEFS: ReadonlyArray<[string, string, string]> = [
  [
    'tools-call-unknown-tool-protocol-error',
    'ToolsCallUnknownToolProtocolError',
    'Calling a tool the server does not have yields a JSON-RPC error response'
  ],
  [
    'tools-call-unknown-tool-error-code',
    'ToolsCallUnknownToolErrorCode',
    'Unknown tool error uses code -32602 (Invalid params), as in the specification example'
  ],
  [
    'jsonrpc-error-code-integer',
    'JsonRpcErrorCodeInteger',
    'Error codes MUST be integers'
  ],
  [
    'jsonrpc-error-message-string',
    'JsonRpcErrorMessageString',
    'Error responses MUST include an error field with a code and message'
  ],
  [
    'jsonrpc-error-response-no-result',
    'JsonRpcErrorResponseNoResult',
    'An error response carries no result member'
  ],
  [
    'jsonrpc-error-response-id-matches',
    'JsonRpcErrorResponseIdMatches',
    'Error responses MUST include the same ID as the request they correspond to'
  ],
  [
    'jsonrpc-error-response-id-string-preserved',
    'JsonRpcErrorResponseIdStringPreserved',
    'A string request id is echoed on the error response as the same string'
  ],
  [
    'jsonrpc-result-response-id-string-preserved',
    'JsonRpcResultResponseIdStringPreserved',
    'Result responses MUST include the same ID as the request they correspond to, including a string id'
  ]
];
