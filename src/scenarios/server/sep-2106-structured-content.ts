/**
 * SEP-2106 structuredContent wire-shape scenario
 *
 * Complements the SEP-2106 keyword-preservation checks that #295 added to
 * `JsonSchema2020_12Scenario` by exercising the other half of SEP-2106:
 * the loosened wire-format for `outputSchema` and `structuredContent`.
 *
 *   - `outputSchema` may be any JSON Schema 2020-12 (not just `type: "object"`),
 *     so arrays and primitives at the root are now valid.
 *   - `structuredContent` widens from `{[key: string]: unknown}` to `unknown`,
 *     so a tool can return a raw array, number, string, etc. directly.
 *
 * SEP-2106's motivation section is largely about this wire shape (the
 * weather-forecast and get-count examples), so it warrants its own checks
 * even though the spec diff added no new RFC 2119 sentences — this is a
 * capability test, same pattern as SEP-1613 / the existing
 * `JsonSchema2020_12Scenario`.
 *
 * Why raw HTTP: the MCP SDK Client's response validator rejects non-object
 * `outputSchema` and non-object `structuredContent` (the very shapes this
 * scenario inspects), and the SDK Server refuses to emit them. Raw HTTP
 * bypasses both validators so the scenario can see what the server actually
 * put on the wire. This is also why the scenario lives in
 * `pendingClientScenariosList` only — until the SDK ships SEP-2106 support,
 * the in-repo everything-server cannot satisfy these checks. The compliant
 * reference target is `examples/servers/typescript/sep-2106-compliant-server.ts`.
 */

import http from 'http';
import { DRAFT_PROTOCOL_VERSION } from '../../types.js';
import type { ClientScenario, ConformanceCheck } from '../../types.js';

const ARRAY_TOOL = 'sep_2106_array_output_tool';
const PRIMITIVE_TOOL = 'sep_2106_primitive_output_tool';

const SPEC_REFERENCES = [
  {
    id: 'SEP-2106',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2106'
  },
  {
    id: 'tools#structured-content',
    url: 'https://modelcontextprotocol.io/specification/draft/server/tools#structured-content'
  }
];

function now(): string {
  return new Date().toISOString();
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/**
 * POST a JSON-RPC request to a Streamable-HTTP MCP endpoint. Handles both
 * application/json and text/event-stream responses (the transport may pick
 * either; SSE is parsed back to the concatenated `data:` JSON payload).
 */
function postJsonRpc(
  serverUrl: string,
  body: object,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(serverUrl);
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers
        }
      },
      (res) => {
        res.setEncoding('utf8');
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const contentType = (res.headers['content-type'] ?? '').toLowerCase();
          let parsed: unknown = raw;
          if (raw.length === 0) {
            parsed = null;
          } else if (contentType.includes('text/event-stream')) {
            const dataLines = raw
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .filter((l) => l.length > 0);
            const joined = dataLines.join('');
            try {
              parsed = joined ? JSON.parse(joined) : null;
            } catch {
              parsed = raw;
            }
          } else if (contentType.includes('application/json')) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function extractSessionId(res: RawResponse): string | undefined {
  const raw = res.headers['mcp-session-id'];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

async function initSession(serverUrl: string): Promise<string | undefined> {
  const initRes = await postJsonRpc(serverUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: DRAFT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'sep-2106-structured-content-client',
        version: '1.0.0'
      }
    }
  });
  if (initRes.status < 200 || initRes.status >= 300) {
    throw new Error(
      `initialize failed with HTTP ${initRes.status}: ${JSON.stringify(initRes.body)}`
    );
  }
  const initBody = initRes.body as { error?: unknown } | null;
  if (initBody && typeof initBody === 'object' && 'error' in initBody) {
    throw new Error(
      `initialize returned JSON-RPC error: ${JSON.stringify(initBody.error)}`
    );
  }
  const sessionId = extractSessionId(initRes);
  const notifHeaders: Record<string, string> = {};
  if (sessionId) notifHeaders['mcp-session-id'] = sessionId;
  try {
    await postJsonRpc(
      serverUrl,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      notifHeaders
    );
  } catch {
    // Notification ack is best-effort.
  }
  return sessionId;
}

interface ToolRecord {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

async function rawListTools(
  serverUrl: string,
  sessionId: string | undefined,
  id: number
): Promise<ToolRecord[]> {
  const headers: Record<string, string> = {};
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await postJsonRpc(
    serverUrl,
    { jsonrpc: '2.0', id, method: 'tools/list', params: {} },
    headers
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `tools/list failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`
    );
  }
  const body = res.body as {
    result?: { tools?: ToolRecord[] };
    error?: unknown;
  } | null;
  if (body && typeof body === 'object' && 'error' in body) {
    throw new Error(
      `tools/list returned JSON-RPC error: ${JSON.stringify(body.error)}`
    );
  }
  return body?.result?.tools ?? [];
}

interface CallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

async function rawCallTool(
  serverUrl: string,
  sessionId: string | undefined,
  id: number,
  name: string
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await postJsonRpc(
    serverUrl,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: {} }
    },
    headers
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `tools/call(${name}) failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`
    );
  }
  const body = res.body as { result?: CallResult; error?: unknown } | null;
  if (body && typeof body === 'object' && 'error' in body) {
    throw new Error(
      `tools/call(${name}) returned JSON-RPC error: ${JSON.stringify(body.error)}`
    );
  }
  return body?.result ?? {};
}

export class Sep2106StructuredContentScenario implements ClientScenario {
  name = 'sep-2106-structured-content';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Validates SEP-2106's loosened outputSchema + structuredContent wire shape.

This scenario complements the SEP-2106 keyword-preservation checks in the json-schema-2020-12 scenario by exercising the call-time wire shape SEP-2106 enables.

**Server Implementation Requirements:**

The server MUST advertise two tools whose schemas exercise the loosened outputSchema / structuredContent rules:

1. \`${ARRAY_TOOL}\` — \`outputSchema\` is a JSON Schema with \`type: "array"\` at the root (no \`{type: "object"}\` wrapper). The \`tools/call\` response MUST place a JSON array directly in \`structuredContent\`.

2. \`${PRIMITIVE_TOOL}\` — \`outputSchema\` is a JSON Schema with a primitive type at the root (e.g. \`{ type: "number" }\`). The \`tools/call\` response MUST place a raw number directly in \`structuredContent\`.

**Verification**: The scenario lists tools, calls each, and checks that the new schema shapes survive the round-trip without being stripped or rewrapped. Uses raw HTTP rather than the SDK Client because the SDK's response validator (pre-SEP-2106) rejects non-object outputSchema/structuredContent.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let sessionId: string | undefined;
    try {
      sessionId = await initSession(serverUrl);
    } catch (error) {
      checks.push({
        id: 'sep-2106-structured-content-error',
        name: 'Sep2106StructuredContentError',
        description: 'SEP-2106 structuredContent test setup',
        status: 'FAILURE',
        timestamp: now(),
        errorMessage: `Failed to initialize session: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFERENCES
      });
      return checks;
    }

    let tools: ToolRecord[];
    try {
      tools = await rawListTools(serverUrl, sessionId, 2);
    } catch (error) {
      checks.push({
        id: 'sep-2106-structured-content-error',
        name: 'Sep2106StructuredContentError',
        description: 'SEP-2106 structuredContent test tools/list',
        status: 'FAILURE',
        timestamp: now(),
        errorMessage: `Failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFERENCES
      });
      return checks;
    }

    const advertised = tools.map((t) => t.name);
    const arrayTool = tools.find((t) => t.name === ARRAY_TOOL);
    const primitiveTool = tools.find((t) => t.name === PRIMITIVE_TOOL);

    // ─── Array-output tool ───────────────────────────────────────────────
    checks.push({
      id: 'sep-2106-array-output-tool-found',
      name: 'Sep2106ArrayOutputToolFound',
      description: `Server advertises tool '${ARRAY_TOOL}'`,
      status: arrayTool ? 'SUCCESS' : 'FAILURE',
      timestamp: now(),
      errorMessage: arrayTool
        ? undefined
        : `Tool '${ARRAY_TOOL}' not found. Available tools: ${advertised.join(', ') || 'none'}`,
      specReferences: SPEC_REFERENCES,
      details: { advertised }
    });

    if (arrayTool) {
      const output = arrayTool.outputSchema;
      const isArrayRoot = !!output && output.type === 'array';

      checks.push({
        id: 'sep-2106-array-output-schema-preserved',
        name: 'Sep2106ArrayOutputSchemaPreserved',
        description: `${ARRAY_TOOL} advertises an array-at-root outputSchema (SEP-2106 loosened outputSchema)`,
        status: isArrayRoot ? 'SUCCESS' : 'FAILURE',
        timestamp: now(),
        errorMessage: !output
          ? `outputSchema is missing on '${ARRAY_TOOL}'`
          : !isArrayRoot
            ? `outputSchema.type is ${JSON.stringify(output.type)}, expected 'array'. SDK may have wrapped the array in an object — SEP-2106 removes the type: "object" requirement on outputSchema.`
            : undefined,
        specReferences: SPEC_REFERENCES,
        details: { outputSchema: output }
      });

      try {
        const callResult = await rawCallTool(
          serverUrl,
          sessionId,
          3,
          ARRAY_TOOL
        );
        const sc = callResult.structuredContent;
        const isArraySc = Array.isArray(sc);

        checks.push({
          id: 'sep-2106-array-structured-content',
          name: 'Sep2106ArrayStructuredContent',
          description: `${ARRAY_TOOL} returns a JSON array directly in structuredContent (SEP-2106 widens structuredContent to any JSON value)`,
          status: isArraySc ? 'SUCCESS' : 'FAILURE',
          timestamp: now(),
          errorMessage: isArraySc
            ? undefined
            : sc === undefined
              ? 'structuredContent is missing from the call result'
              : `structuredContent is ${typeof sc}, expected array. SDK may have wrapped the array in an object before sending.`,
          specReferences: SPEC_REFERENCES,
          details: { structuredContent: sc }
        });
      } catch (err) {
        checks.push({
          id: 'sep-2106-array-structured-content',
          name: 'Sep2106ArrayStructuredContent',
          description: `Call to ${ARRAY_TOOL} failed`,
          status: 'FAILURE',
          timestamp: now(),
          errorMessage: `tools/call threw: ${err instanceof Error ? err.message : String(err)}`,
          specReferences: SPEC_REFERENCES
        });
      }
    }

    // ─── Primitive-output tool ───────────────────────────────────────────
    checks.push({
      id: 'sep-2106-primitive-output-tool-found',
      name: 'Sep2106PrimitiveOutputToolFound',
      description: `Server advertises tool '${PRIMITIVE_TOOL}'`,
      status: primitiveTool ? 'SUCCESS' : 'FAILURE',
      timestamp: now(),
      errorMessage: primitiveTool
        ? undefined
        : `Tool '${PRIMITIVE_TOOL}' not found. Available tools: ${advertised.join(', ') || 'none'}`,
      specReferences: SPEC_REFERENCES,
      details: { advertised }
    });

    if (primitiveTool) {
      const output = primitiveTool.outputSchema;
      const isPrimitiveRoot = !!output && output.type === 'number';

      checks.push({
        id: 'sep-2106-primitive-output-schema-preserved',
        name: 'Sep2106PrimitiveOutputSchemaPreserved',
        description: `${PRIMITIVE_TOOL} advertises a primitive outputSchema (SEP-2106 loosened outputSchema)`,
        status: isPrimitiveRoot ? 'SUCCESS' : 'FAILURE',
        timestamp: now(),
        errorMessage: !output
          ? `outputSchema is missing on '${PRIMITIVE_TOOL}'`
          : !isPrimitiveRoot
            ? `outputSchema.type is ${JSON.stringify(output.type)}, expected 'number'. SDK may have wrapped the primitive in an object.`
            : undefined,
        specReferences: SPEC_REFERENCES,
        details: { outputSchema: output }
      });

      try {
        const callResult = await rawCallTool(
          serverUrl,
          sessionId,
          4,
          PRIMITIVE_TOOL
        );
        const sc = callResult.structuredContent;
        const isNumberSc = typeof sc === 'number';

        checks.push({
          id: 'sep-2106-primitive-structured-content',
          name: 'Sep2106PrimitiveStructuredContent',
          description: `${PRIMITIVE_TOOL} returns a raw number in structuredContent (SEP-2106 widens structuredContent)`,
          status: isNumberSc ? 'SUCCESS' : 'FAILURE',
          timestamp: now(),
          errorMessage: isNumberSc
            ? undefined
            : sc === undefined
              ? 'structuredContent is missing from the call result'
              : `structuredContent is ${typeof sc} (${JSON.stringify(sc)}), expected number. SDK may have wrapped the primitive in an object.`,
          specReferences: SPEC_REFERENCES,
          details: { structuredContent: sc }
        });
      } catch (err) {
        checks.push({
          id: 'sep-2106-primitive-structured-content',
          name: 'Sep2106PrimitiveStructuredContent',
          description: `Call to ${PRIMITIVE_TOOL} failed`,
          status: 'FAILURE',
          timestamp: now(),
          errorMessage: `tools/call threw: ${err instanceof Error ? err.message : String(err)}`,
          specReferences: SPEC_REFERENCES
        });
      }
    }

    return checks;
  }
}
