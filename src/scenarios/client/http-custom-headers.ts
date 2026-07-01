import type { ScenarioContext } from '../../mock-server';
/**
 * HTTP Custom Headers conformance test scenario for MCP clients (SEP-2243)
 *
 * Tests that clients correctly handle the `x-mcp-header` extension property:
 * 1. Mirror annotated tool parameter values into `Mcp-Param-{Name}` headers
 * 2. Apply correct value encoding (plain ASCII, Base64 for non-ASCII)
 * 3. Reject tool definitions with invalid `x-mcp-header` annotations
 *
 * This is a Scenario (acts as a test server that inspects incoming requests
 * from the client under test).
 */

import http from 'http';
import { ScenarioUrls, ConformanceCheck } from '../../types.js';
import { BaseHttpScenario } from './http-base.js';

const SPEC_REFERENCE_CUSTOM = {
  id: 'SEP-2243-Custom-Headers',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#custom-headers-from-tool-parameters'
};

const SPEC_REFERENCE_ENCODING = {
  id: 'SEP-2243-Value-Encoding',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#value-encoding'
};

const SPEC_REFERENCE_TOOL_DEF = {
  id: 'SEP-2243-x-mcp-header',
  url: 'https://modelcontextprotocol.io/specification/draft/server/tools#x-mcp-header'
};

/**
 * Every requirement-level check ID HttpCustomHeadersScenario can emit
 * (SEP-2243). Declared-but-unemitted checks are backfilled as FAILURE by
 * getChecks() — same pattern as request-metadata.ts — so the emitted ID set
 * is stable for traceability even when the client never exercises the
 * feature.
 */
export const CUSTOM_HEADERS_DECLARED_CHECK_IDS = [
  'sep-2243-client-supports-custom-headers',
  'sep-2243-client-mirrors-designated-params',
  'sep-2243-client-encode-values',
  'sep-2243-client-base64-unsafe',
  'sep-2243-client-omit-null'
] as const;

/**
 * Every requirement-level check ID HttpInvalidToolHeadersScenario can emit
 * (SEP-2243).
 */
export const INVALID_TOOL_DECLARED_CHECK_IDS = [
  'sep-2243-client-reject-invalid-tool',
  'sep-2243-x-mcp-header-not-empty',
  'sep-2243-x-mcp-header-charset',
  'sep-2243-x-mcp-header-unique',
  'sep-2243-x-mcp-header-primitive-only'
] as const;

/**
 * Invalid tool definitions served by HttpInvalidToolHeadersScenario, keyed by
 * tool name, mapped to the SEP-2243 x-mcp-header constraint each one
 * violates. The check for "client did not call this tool" is emitted under
 * the constraint's requirement ID so each constraint traces to a check.
 */
const INVALID_TOOL_CONSTRAINT_IDS: Record<string, string> = {
  invalid_empty_header: 'sep-2243-x-mcp-header-not-empty',
  invalid_object_header: 'sep-2243-x-mcp-header-primitive-only',
  invalid_array_header: 'sep-2243-x-mcp-header-primitive-only',
  invalid_null_header: 'sep-2243-x-mcp-header-primitive-only',
  invalid_duplicate_same_case: 'sep-2243-x-mcp-header-unique',
  invalid_duplicate_diff_case: 'sep-2243-x-mcp-header-unique',
  invalid_space_in_name: 'sep-2243-x-mcp-header-charset',
  invalid_colon_in_name: 'sep-2243-x-mcp-header-charset',
  invalid_non_ascii_name: 'sep-2243-x-mcp-header-charset',
  invalid_control_char_name: 'sep-2243-x-mcp-header-charset'
};

/**
 * Decodes a header value that may be Base64-encoded.
 * Base64-encoded values use the format: =?base64?{Base64EncodedValue}?=
 */
function decodeHeaderValue(value: string): string {
  const base64Match = value.match(/^=\?base64\?(.*)\?=$/);
  if (base64Match) {
    return Buffer.from(base64Match[1], 'base64').toString('utf-8');
  }
  return value;
}

/**
 * Check if a value needs Base64 encoding per the spec:
 * - Non-ASCII characters
 * - Control characters
 * - Leading/trailing whitespace
 */
function needsBase64Encoding(value: string): boolean {
  // Check for non-ASCII or control characters
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      // Allow space (0x20) and tab (0x09) only inside values, not at edges
      if (code === 0x09) return true; // tab always needs encoding
      if (code < 0x20) return true; // other control chars
      if (code > 0x7e) return true; // non-ASCII
    }
  }
  // Check for leading/trailing whitespace
  if (value !== value.trim()) return true;
  return false;
}

/**
 * Checks if a raw header value is properly encoded for a body value that
 * needs Base64 encoding. Returns null if valid, error string if invalid.
 */
function validateEncodedHeader(
  rawHeader: string,
  bodyValue: string,
  valueType?: string
): string | null {
  if (needsBase64Encoding(bodyValue)) {
    // Value requires Base64 encoding
    const base64Match = rawHeader.match(/^=\?base64\?(.*)\?=$/);

    if (!base64Match) {
      return `Value '${bodyValue}' requires Base64 encoding but header was sent as plain: '${rawHeader}'`;
    }
    const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8');
    if (valueType === 'number' || valueType === 'integer') {
      return compareNumericValues(decoded, bodyValue);
    }
    if (decoded !== bodyValue) {
      return `Base64-decoded header value '${decoded}' does not match body value '${bodyValue}'`;
    }
    return null;
  }
  // Plain ASCII - compare directly (after decoding if Base64 was used)
  const decoded = decodeHeaderValue(rawHeader);
  if (valueType === 'number' || valueType === 'integer') {
    return compareNumericValues(decoded, bodyValue);
  }
  if (decoded !== bodyValue) {
    return `Header value '${decoded}' (raw: '${rawHeader}') does not match body value '${bodyValue}'`;
  }
  return null;
}

/**
 * Compare two string representations of numbers numerically.
 * For integers, requires exact match. For decimals, allows
 * a tolerance of 1e-9 to account for cross-SDK floating point
 * representation differences.
 */
function compareNumericValues(
  headerValue: string,
  bodyValue: string
): string | null {
  const headerNum = Number(headerValue);
  const bodyNum = Number(bodyValue);
  if (isNaN(headerNum) || isNaN(bodyNum)) {
    return `Non-numeric value in number comparison: header='${headerValue}', body='${bodyValue}'`;
  }
  if (Number.isInteger(bodyNum)) {
    // Integer: require exact numeric match (e.g. 42 === 42.0)
    if (headerNum !== bodyNum) {
      return `Numeric header value ${headerNum} does not match body value ${bodyNum}`;
    }
  } else {
    // Decimal: allow tolerance of 1e-9
    if (Math.abs(headerNum - bodyNum) > 1e-9) {
      return `Numeric header value ${headerNum} does not match body value ${bodyNum} (difference ${Math.abs(headerNum - bodyNum)} exceeds tolerance 1e-9)`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HttpCustomHeadersScenario - tests that clients mirror x-mcp-header params
// ─────────────────────────────────────────────────────────────────────────────

export class HttpCustomHeadersScenario extends BaseHttpScenario {
  name = 'http-custom-headers';
  description =
    'Tests that client mirrors x-mcp-header tool parameters into Mcp-Param headers with correct encoding (SEP-2243)';

  private toolCallReceived: boolean = false;
  private nullToolCallReceived: boolean = false;

  async start(_ctx: ScenarioContext): Promise<ScenarioUrls> {
    const urls = await super.start(_ctx);
    // Pass test values via context for encoding edge cases.
    // The conformance client should use these values when calling test_custom_headers.
    urls.context = {
      toolCalls: [
        {
          name: 'test_custom_headers',
          arguments: {
            region: 'us-west1',
            priority: 42,
            verbose: false,
            debug: true,
            empty_val: '',
            method_val: 'test-method',
            float_val: 3.14159,
            non_ascii_val: 'Hello, 世界',
            whitespace_val: ' padded ',
            leading_space_val: ' us-west1',
            trailing_space_val: 'us-west1 ',
            internal_space_val: 'us west 1',
            control_char_val: 'line1\nline2',
            crlf_val: 'line1\r\nline2',
            tab_val: '\tindented',
            query: 'SELECT * FROM users'
          }
        },
        {
          name: 'test_custom_headers_null',
          arguments: {
            region: 'us-east1',
            priority: 1,
            verbose: null,
            query: 'SELECT 1'
          }
        }
      ]
    };
    return urls;
  }

  getChecks(): ConformanceCheck[] {
    // Declared-but-unemitted -> FAILURE (request-metadata.ts pattern). Keeps
    // the emitted ID set stable for traceability even when the client never
    // calls the annotated tools. The `some()` guard makes this idempotent.
    for (const id of CUSTOM_HEADERS_DECLARED_CHECK_IDS) {
      if (this.checks.some((c) => c.id === id)) continue;
      const missingNullCall =
        id === 'sep-2243-client-omit-null' && !this.nullToolCallReceived;
      this.checks.push({
        id,
        name: 'NotObserved',
        description: `Declared check ${id} was never emitted`,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: missingNullCall
          ? 'Client did not send a tools/call request for test_custom_headers_null to test null/omitted parameter handling.'
          : this.toolCallReceived
            ? 'Check was not observed: no tool call exercised it.'
            : 'Client did not send a tools/call request for test_custom_headers.',
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    }
    return this.checks;
  }

  protected handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    if (request.method === 'initialize') {
      this.sendInitialize(res, request);
    } else if (request.method === 'tools/list') {
      this.handleToolsList(res, request);
    } else if (request.method === 'tools/call') {
      this.handleToolsCall(req, res, request);
    } else if (request.id === undefined) {
      this.sendNotificationAck(res);
    } else {
      this.sendGenericResult(res, request);
    }
  }

  private handleToolsList(res: http.ServerResponse, request: any): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        tools: [
          {
            name: 'test_custom_headers',
            description:
              'A tool with x-mcp-header annotations to test custom header mirroring and encoding',
            inputSchema: {
              type: 'object',
              properties: {
                region: {
                  type: 'string',
                  description: 'Plain ASCII string value',
                  'x-mcp-header': 'Region'
                },
                priority: {
                  type: 'integer',
                  description: 'Integer numeric value',
                  'x-mcp-header': 'Priority'
                },
                verbose: {
                  type: 'boolean',
                  description: 'Boolean value',
                  'x-mcp-header': 'Verbose'
                },
                debug: {
                  type: 'boolean',
                  description: 'Boolean true value',
                  'x-mcp-header': 'Debug'
                },
                empty_val: {
                  type: 'string',
                  description: 'Empty string value',
                  'x-mcp-header': 'EmptyVal'
                },
                method_val: {
                  type: 'string',
                  description:
                    'Value for header named "Method" — tests that x-mcp-header "Method" produces Mcp-Param-Method (not Mcp-Method)',
                  'x-mcp-header': 'Method'
                },
                float_val: {
                  type: 'number',
                  description:
                    'Floating point value — no x-mcp-header annotation, should not be mirrored'
                },
                non_ascii_val: {
                  type: 'string',
                  description:
                    'Non-ASCII string value — requires Base64 encoding',
                  'x-mcp-header': 'NonAscii'
                },
                whitespace_val: {
                  type: 'string',
                  description:
                    'String with leading/trailing whitespace — requires Base64 encoding',
                  'x-mcp-header': 'Whitespace'
                },
                leading_space_val: {
                  type: 'string',
                  description:
                    'String with leading space only — requires Base64 encoding',
                  'x-mcp-header': 'LeadingSpace'
                },
                trailing_space_val: {
                  type: 'string',
                  description:
                    'String with trailing space only — requires Base64 encoding',
                  'x-mcp-header': 'TrailingSpace'
                },
                internal_space_val: {
                  type: 'string',
                  description:
                    'String with internal spaces only — plain ASCII, no Base64',
                  'x-mcp-header': 'InternalSpace'
                },
                control_char_val: {
                  type: 'string',
                  description:
                    'String with control characters — requires Base64 encoding',
                  'x-mcp-header': 'ControlChar'
                },
                crlf_val: {
                  type: 'string',
                  description:
                    'String with carriage return and line feed — requires Base64 encoding',
                  'x-mcp-header': 'CrLf'
                },
                tab_val: {
                  type: 'string',
                  description:
                    'String with leading tab — requires Base64 encoding',
                  'x-mcp-header': 'Tab'
                },
                query: {
                  type: 'string',
                  description:
                    'No x-mcp-header annotation - should not be mirrored'
                }
              },
              required: ['region', 'priority', 'query']
            }
          },
          {
            name: 'test_custom_headers_null',
            description:
              'A tool for testing null/omitted x-mcp-header parameter handling',
            inputSchema: {
              type: 'object',
              properties: {
                region: {
                  type: 'string',
                  description: 'Plain ASCII string value',
                  'x-mcp-header': 'Region'
                },
                priority: {
                  type: 'integer',
                  description: 'Integer numeric value',
                  'x-mcp-header': 'Priority'
                },
                verbose: {
                  type: 'boolean',
                  description: 'Boolean value — will be null to test omission',
                  'x-mcp-header': 'Verbose'
                },
                query: {
                  type: 'string',
                  description: 'No x-mcp-header annotation'
                }
              },
              required: ['region', 'priority', 'query']
            }
          }
        ]
      }
    });
  }

  private handleToolsCall(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    const toolName = request.params?.name;
    const args = request.params?.arguments || {};

    if (toolName === 'test_custom_headers') {
      this.toolCallReceived = true;

      // SEP-2243 "MCP clients MUST support this feature": observable as the
      // client calling the annotated tool with at least one mirrored
      // Mcp-Param-* header. The per-parameter checks below then validate each
      // mirrored value individually.
      const hasAnyParamHeader = Object.keys(req.headers).some((h) =>
        h.startsWith('mcp-param-')
      );
      this.checks.push({
        id: 'sep-2243-client-supports-custom-headers',
        name: 'ClientSupportsCustomHeaders',
        description:
          'Client supports custom headers: calls the x-mcp-header annotated tool and mirrors at least one parameter',
        status: hasAnyParamHeader ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: hasAnyParamHeader
          ? undefined
          : 'Client called test_custom_headers but sent no Mcp-Param-* headers.',
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });

      // Check Mcp-Param-Region header (plain ASCII string)
      this.checkParamHeader(req, 'Region', args.region, 'string');

      // Check Mcp-Param-Priority header (integer)
      this.checkParamHeader(req, 'Priority', args.priority, 'integer');

      // Check Mcp-Param-Verbose header (boolean value)
      // checkParamHeader already FAILs on missing header, so this also covers
      // "optional parameter present → client MUST include header" without a
      // separate check id.
      if (args.verbose !== undefined && args.verbose !== null) {
        this.checkParamHeader(req, 'Verbose', args.verbose, 'boolean');
      }

      // Check Mcp-Param-Debug header (boolean true value)
      if (args.debug !== undefined && args.debug !== null) {
        this.checkParamHeader(req, 'Debug', args.debug, 'boolean');
      }

      // Check Mcp-Param-EmptyVal header (empty string → empty header value)
      if (args.empty_val !== undefined && args.empty_val !== null) {
        this.checkParamHeader(req, 'EmptyVal', args.empty_val, 'string');
      }

      // Check Mcp-Param-Method header (x-mcp-header "Method" → Mcp-Param-Method, NOT Mcp-Method)
      if (args.method_val !== undefined && args.method_val !== null) {
        this.checkParamHeader(req, 'Method', args.method_val, 'string');
      }

      // float_val is intentionally unannotated: SEP-2243 forbids x-mcp-header on
      // `number`-typed properties, so it is served without one. Assert no header
      // was sent — same "designated params only" rule as the `query` check below.
      const floatHeader = req.headers['mcp-param-floatval'] as
        | string
        | undefined;
      this.checks.push({
        id: 'sep-2243-client-mirrors-designated-params',
        name: 'ClientCustomHeaderNoMirrorNumber',
        description:
          'Client MUST NOT add Mcp-Param headers for parameters without x-mcp-header (number-typed float_val is served unannotated per SEP-2243)',
        status: floatHeader === undefined ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          floatHeader !== undefined
            ? `Found unexpected Mcp-Param-FloatVal header '${floatHeader}' for an unannotated number parameter`
            : undefined,
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });

      // Check Mcp-Param-NonAscii header (requires Base64 encoding)
      if (args.non_ascii_val !== undefined && args.non_ascii_val !== null) {
        this.checkParamHeader(req, 'NonAscii', args.non_ascii_val, 'string');
      }

      // Check Mcp-Param-Whitespace header (leading/trailing whitespace → Base64)
      if (args.whitespace_val !== undefined && args.whitespace_val !== null) {
        this.checkParamHeader(req, 'Whitespace', args.whitespace_val, 'string');
      }

      // Check Mcp-Param-LeadingSpace header (leading space only → Base64)
      if (
        args.leading_space_val !== undefined &&
        args.leading_space_val !== null
      ) {
        this.checkParamHeader(
          req,
          'LeadingSpace',
          args.leading_space_val,
          'string'
        );
      }

      // Check Mcp-Param-TrailingSpace header (trailing space only → Base64)
      if (
        args.trailing_space_val !== undefined &&
        args.trailing_space_val !== null
      ) {
        this.checkParamHeader(
          req,
          'TrailingSpace',
          args.trailing_space_val,
          'string'
        );
      }

      // Check Mcp-Param-InternalSpace header (internal spaces only → plain ASCII, no Base64)
      if (
        args.internal_space_val !== undefined &&
        args.internal_space_val !== null
      ) {
        this.checkParamHeader(
          req,
          'InternalSpace',
          args.internal_space_val,
          'string'
        );
      }

      // Check Mcp-Param-ControlChar header (control characters → Base64)
      if (
        args.control_char_val !== undefined &&
        args.control_char_val !== null
      ) {
        this.checkParamHeader(
          req,
          'ControlChar',
          args.control_char_val,
          'string'
        );
      }

      // Check Mcp-Param-CrLf header (carriage return + line feed → Base64)
      if (args.crlf_val !== undefined && args.crlf_val !== null) {
        this.checkParamHeader(req, 'CrLf', args.crlf_val, 'string');
      }

      // Check Mcp-Param-Tab header (leading tab → Base64)
      if (args.tab_val !== undefined && args.tab_val !== null) {
        this.checkParamHeader(req, 'Tab', args.tab_val, 'string');
      }

      // Check that 'query' (no x-mcp-header) is NOT mirrored — the negative
      // half of "mirror the *designated* parameter values".
      const queryHeader = req.headers['mcp-param-query'] as string | undefined;
      this.checks.push({
        id: 'sep-2243-client-mirrors-designated-params',
        name: 'ClientCustomHeaderNoMirrorUnannotated',
        description:
          'Client MUST NOT add Mcp-Param headers for parameters without x-mcp-header',
        status: queryHeader === undefined ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          queryHeader !== undefined
            ? `Found unexpected Mcp-Param-Query header '${queryHeader}' for unannotated parameter`
            : undefined,
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    } else if (toolName === 'test_custom_headers_null') {
      this.nullToolCallReceived = true;

      // When value is null or not provided, client MUST omit the header
      const verboseHeader = req.headers['mcp-param-verbose'] as
        | string
        | undefined;
      this.checks.push({
        id: 'sep-2243-client-omit-null',
        name: 'ClientCustomHeaderOmitNull',
        description:
          'Client MUST omit Mcp-Param header when parameter value is null or not provided',
        status: verboseHeader === undefined ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          verboseHeader !== undefined
            ? `Mcp-Param-Verbose should be omitted when null/undefined, but got '${verboseHeader}'`
            : undefined,
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    }

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'Custom headers test completed' }]
      }
    });
  }

  private checkParamHeader(
    req: http.IncomingMessage,
    headerName: string,
    bodyValue: any,
    valueType: string
  ): void {
    const headerKey = `mcp-param-${headerName.toLowerCase()}`;
    const rawHeaderValue = req.headers[headerKey] as string | undefined;

    if (bodyValue === undefined || bodyValue === null) return;

    const errors: string[] = [];

    if (rawHeaderValue === undefined) {
      errors.push(
        `Missing Mcp-Param-${headerName} header. Client MUST include headers for x-mcp-header parameters.`
      );
    } else {
      // Convert body value to expected string representation
      let expectedString: string;
      switch (valueType) {
        case 'number':
          expectedString = String(bodyValue);
          break;
        case 'boolean':
          expectedString = bodyValue ? 'true' : 'false';
          break;
        default:
          expectedString = String(bodyValue);
      }

      // For numbers, compare numerically to allow for cross-SDK
      // floating point representation differences (e.g., "42" vs "42.0").
      // See SEP-2243 discussion on number precision.
      const validationError = validateEncodedHeader(
        rawHeaderValue,
        expectedString,
        valueType
      );
      if (validationError) {
        errors.push(validationError);
      }
    }

    // One check ID per SEP-2243 requirement, picked by what this parameter
    // actually exercises: Base64 wrapping for unsafe values, primitive
    // (number/boolean) string encoding, or plain mirroring. The per-parameter
    // detail lives in `name`/`details`.
    const needsBase64 =
      typeof bodyValue === 'string' && needsBase64Encoding(String(bodyValue));
    const checkId = needsBase64
      ? 'sep-2243-client-base64-unsafe'
      : valueType === 'number' ||
          valueType === 'integer' ||
          valueType === 'boolean'
        ? 'sep-2243-client-encode-values'
        : 'sep-2243-client-mirrors-designated-params';

    this.checks.push({
      id: checkId,
      name: `ClientCustomHeader_${headerName}`,
      description: `Client sends correct Mcp-Param-${headerName} header (${valueType} value)`,
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: [SPEC_REFERENCE_ENCODING],
      details: {
        headerName: `Mcp-Param-${headerName}`,
        rawHeaderValue,
        bodyValue,
        valueType,
        needsBase64
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HttpInvalidToolHeadersScenario - tests that clients reject invalid tools
// ─────────────────────────────────────────────────────────────────────────────

export class HttpInvalidToolHeadersScenario extends BaseHttpScenario {
  name = 'http-invalid-tool-headers';
  description =
    'Tests that client rejects tools with invalid x-mcp-header annotations (SEP-2243)';
  allowClientError = true;

  private calledTools: Set<string> = new Set();
  private toolsListSent = false;

  getChecks(): ConformanceCheck[] {
    if (!this.toolsListSent) {
      this.checks.push({
        id: 'sep-2243-invalid-tool-tools-list-gate',
        name: 'ClientInvalidToolHeadersToolsList',
        description: 'Client requests tools/list',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: 'Client did not send a tools/list request.',
        specReferences: [SPEC_REFERENCE_TOOL_DEF]
      });
    }

    // Check that valid_tool WAS called — proves client kept valid tools
    const validToolCalled = this.calledTools.has('valid_tool');
    this.checks.push({
      id: 'sep-2243-client-reject-invalid-tool',
      name: 'ClientKeepsValidTool',
      description: 'Client MUST keep valid tools while excluding invalid ones',
      status: validToolCalled ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: validToolCalled
        ? undefined
        : "Client did not call 'valid_tool'. A single malformed tool definition must not prevent other valid tools from being used.",
      specReferences: [SPEC_REFERENCE_TOOL_DEF]
    });

    // Check that the client did NOT call any of the invalid tools. Each
    // invalid tool violates one specific x-mcp-header constraint, so the
    // check is emitted under that constraint's requirement ID — the client
    // rejecting the tool is how the constraint is enforced on the wire.
    for (const [toolName, constraintId] of Object.entries(
      INVALID_TOOL_CONSTRAINT_IDS
    )) {
      const called = this.calledTools.has(toolName);
      this.checks.push({
        id: constraintId,
        name: `ClientRejectsInvalidTool_${toolName}`,
        description: `Client MUST NOT call tool '${toolName}' with invalid x-mcp-header`,
        status: called ? 'FAILURE' : 'SUCCESS',
        timestamp: new Date().toISOString(),
        errorMessage: called
          ? `Client called '${toolName}' which has an invalid x-mcp-header. Clients MUST reject (exclude) such tools.`
          : undefined,
        specReferences: [SPEC_REFERENCE_TOOL_DEF]
      });
    }

    return this.checks;
  }

  protected handlePost(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    if (request.method === 'initialize') {
      this.sendInitialize(res, request);
    } else if (request.method === 'tools/list') {
      this.handleToolsList(res, request);
    } else if (request.method === 'tools/call') {
      this.handleToolsCall(res, request);
    } else if (request.id === undefined) {
      this.sendNotificationAck(res);
    } else {
      this.sendGenericResult(res, request);
    }
  }

  private handleToolsList(res: http.ServerResponse, request: any): void {
    this.toolsListSent = true;

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        tools: [
          // ── Valid tool (should be kept by client) ──
          {
            name: 'valid_tool',
            description: 'A valid tool with correct x-mcp-header',
            inputSchema: {
              type: 'object',
              properties: {
                region: {
                  type: 'string',
                  'x-mcp-header': 'Region'
                }
              },
              required: ['region']
            }
          },

          // ── Invalid: empty x-mcp-header value ──
          {
            name: 'invalid_empty_header',
            description:
              'x-mcp-header MUST NOT be empty (MUST be rejected by client)',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string', 'x-mcp-header': '' }
              },
              required: ['value']
            }
          },

          // ── Invalid: x-mcp-header on object type ──
          {
            name: 'invalid_object_header',
            description:
              'x-mcp-header MUST only be on primitive types (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                data: { type: 'object', 'x-mcp-header': 'Data' }
              },
              required: ['data']
            }
          },

          // ── Invalid: x-mcp-header on array type ──
          {
            name: 'invalid_array_header',
            description:
              'x-mcp-header MUST only be on primitive types (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: { type: 'string' },
                  'x-mcp-header': 'Items'
                }
              },
              required: ['items']
            }
          },

          // ── Invalid: x-mcp-header on null type ──
          {
            name: 'invalid_null_header',
            description:
              'x-mcp-header MUST only be on primitive types (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                nil: { type: 'null', 'x-mcp-header': 'Nil' }
              },
              required: ['nil']
            }
          },

          // ── Invalid: duplicate same-case x-mcp-header values ──
          {
            name: 'invalid_duplicate_same_case',
            description:
              'Duplicate x-mcp-header "Region" on two properties (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                field1: { type: 'string', 'x-mcp-header': 'Region' },
                field2: { type: 'string', 'x-mcp-header': 'Region' }
              },
              required: ['field1', 'field2']
            }
          },

          // ── Invalid: duplicate case-insensitive x-mcp-header values ──
          {
            name: 'invalid_duplicate_diff_case',
            description:
              'Duplicate case-insensitive x-mcp-header "MyField"/"myfield" (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                field1: { type: 'string', 'x-mcp-header': 'MyField' },
                field2: { type: 'string', 'x-mcp-header': 'myfield' }
              },
              required: ['field1', 'field2']
            }
          },

          // ── Invalid: space in x-mcp-header name ──
          {
            name: 'invalid_space_in_name',
            description:
              'x-mcp-header MUST NOT contain space (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string', 'x-mcp-header': 'My Region' }
              },
              required: ['value']
            }
          },

          // ── Invalid: colon in x-mcp-header name ──
          {
            name: 'invalid_colon_in_name',
            description:
              'x-mcp-header MUST NOT contain colon (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                value: {
                  type: 'string',
                  'x-mcp-header': 'Region:Primary'
                }
              },
              required: ['value']
            }
          },

          // ── Invalid: non-ASCII in x-mcp-header name ──
          {
            name: 'invalid_non_ascii_name',
            description:
              'x-mcp-header MUST contain only ASCII chars (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string', 'x-mcp-header': 'Région' }
              },
              required: ['value']
            }
          },

          // ── Invalid: control character in x-mcp-header name ──
          {
            name: 'invalid_control_char_name',
            description:
              'x-mcp-header MUST NOT contain control chars (MUST be rejected)',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string', 'x-mcp-header': 'Region\t1' }
              },
              required: ['value']
            }
          }
        ]
      }
    });
  }

  private handleToolsCall(res: http.ServerResponse, request: any): void {
    const toolName = request.params?.name;
    if (toolName) this.calledTools.add(toolName);

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'Tool call received' }]
      }
    });
  }
}
