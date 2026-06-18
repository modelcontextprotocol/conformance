/**
 * HTTP Standard Headers server validation test scenarios (SEP-2243)
 *
 * Tests that servers properly validate the standard MCP request headers:
 * - Reject requests where Mcp-Method header doesn't match the body
 * - Reject requests where Mcp-Name header doesn't match the body
 * - Accept case variations of header names (case-insensitive)
 * - Reject case variations of header values (case-sensitive)
 * - Handle whitespace trimming per HTTP spec
 * - Validate Base64-encoded custom header values
 * - Return 400 Bad Request with error code -32020 (HeaderMismatch)
 *
 * This is a ClientScenario (connects to a server under test and validates
 * its behavior).
 */

import http from 'http';
import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  withRequestMeta,
  sendStatelessRequest,
  type RunContext
} from '../../connection';
import { HEADER_MISMATCH } from '../../spec-types/draft';

const SPEC_REFERENCE = {
  id: 'SEP-2243-Server-Validation',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#server-validation'
};

const SPEC_REFERENCE_CASE = {
  id: 'SEP-2243-Case-Sensitivity',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#case-sensitivity'
};

// OWS handling is an RFC 9110 §5.5 MUST ("a field parsing implementation MUST
// exclude such whitespace prior to evaluating the field value"), not a
// SEP-2243 requirement. Kept as a check because a server stack that fails it
// has a real HTTP-layer bug that will manifest as header-mismatch rejections.
const SPEC_REFERENCE_RFC9110_OWS = {
  id: 'RFC-9110-5.5-Field-Values',
  url: 'https://www.rfc-editor.org/rfc/rfc9110#section-5.5'
};

const SPEC_REFERENCE_BASE64 = {
  id: 'SEP-2243-Value-Encoding',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#value-encoding'
};

const SPEC_REFERENCE_CUSTOM = {
  id: 'SEP-2243-Custom-Headers',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#server-behavior-for-custom-headers'
};

const HEADER_MISMATCH_ERROR_CODE = HEADER_MISMATCH;

// Coarse, requirement-level check IDs (SEP-2243) for STANDARD-header
// rejections. Every standard-header rejection case emits this same pair of IDs;
// the per-case name/description carry the detail of which case was exercised,
// matching the repo's "same id, vary status/message" convention.
const REJECT_STATUS_CHECK_ID = 'sep-2243-server-reject-invalid-headers';
const REJECT_ERROR_CODE_CHECK_ID = 'sep-2243-server-reject-error-code';

// CUSTOM-header (Mcp-Param-*) rejections map to the param-validation
// requirements instead. The -32020 error-code half of every custom-header
// rejection is the "reject with 400 + JSON-RPC error code -32020 if any
// validation fails" requirement.
const PARAM_REJECT_ERROR_CODE_CHECK_ID =
  'sep-2243-server-reject-param-mismatch';

/**
 * Every requirement-level check ID HttpCustomHeaderServerValidationScenario
 * can emit (SEP-2243). When the server under test exposes no x-mcp-header
 * tool the scenario cannot exercise these, but it still emits one SKIPPED row
 * per ID so the traceability manifest sees that a scenario exists for each
 * requirement (the manifest joins on emitted IDs regardless of status).
 */
export const CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS = [
  'sep-2243-server-decode-base64',
  'sep-2243-server-validate-param-match',
  'sep-2243-server-reject-invalid-param-chars',
  'sep-2243-server-reject-param-mismatch'
] as const;

/**
 * Helper to send a raw HTTP POST request with custom headers.
 * Uses Node.js http.request to preserve exact header casing and values,
 * avoiding normalization that fetch()/Headers may apply.
 */
async function sendRawRequest(
  serverUrl: string,
  body: object,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
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
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let responseBody: any;
          const contentType = res.headers['content-type'];
          if (contentType?.includes('application/json')) {
            try {
              responseBody = JSON.parse(data);
            } catch {
              responseBody = data;
            }
          } else {
            responseBody = data;
          }
          resolve({
            status: res.statusCode || 0,
            body: responseBody,
            headers: res.headers
          });
        });
      }
    );

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Builds two checks for a rejection case: one for the HTTP 400 status, one for
 * the -32020 JSON-RPC error code. Per SEP-2243 §Server Validation, 400 is MUST
 * but -32020 is SHOULD for *standard* headers (and MUST for *custom* headers,
 * §Server Behavior for Custom Headers) — so a server returning 400 with a
 * different error code is compliant for standard headers and must not FAIL.
 *
 * The two emitted check IDs are supplied explicitly by the caller: standard-
 * header callers pass the coarse REJECT_STATUS_CHECK_ID/REJECT_ERROR_CODE_CHECK_ID
 * pair, while custom-header/Base64 callers pass the param-validation
 * requirement that case exercises plus PARAM_REJECT_ERROR_CODE_CHECK_ID. The
 * per-case `name`/`description` distinguish which rejection case was
 * exercised.
 */
function createRejectionChecks(
  statusId: string,
  errorCodeId: string,
  name: string,
  description: string,
  response: { status: number; body: any },
  specRef: { id: string; url: string },
  details: Record<string, unknown>,
  opts: { errorCodeSeverity: 'FAILURE' | 'WARNING' }
): ConformanceCheck[] {
  const fullDetails = {
    ...details,
    responseStatus: response.status,
    responseBody: response.body
  };
  const ts = new Date().toISOString();

  const statusOk = response.status === 400;
  const codeOk = response.body?.error?.code === HEADER_MISMATCH_ERROR_CODE;

  return [
    {
      id: statusId,
      name,
      description,
      status: statusOk ? 'SUCCESS' : 'FAILURE',
      timestamp: ts,
      errorMessage: statusOk
        ? undefined
        : `Expected HTTP 400, got ${response.status}. Server MUST reject with 400 Bad Request.`,
      specReferences: [specRef],
      details: fullDetails
    },
    {
      id: errorCodeId,
      name: `${name}ErrorCode`,
      description: `${description} — uses JSON-RPC error code -32020 (HeaderMismatch)`,
      status: codeOk ? 'SUCCESS' : opts.errorCodeSeverity,
      timestamp: ts,
      errorMessage: codeOk
        ? undefined
        : `Expected JSON-RPC error code ${HEADER_MISMATCH_ERROR_CODE} (HeaderMismatch), got ${response.body?.error?.code ?? '(missing)'}.`,
      specReferences: [specRef],
      details: fullDetails
    }
  ];
}

function createAcceptanceCheck(
  id: string,
  name: string,
  description: string,
  response: { status: number; body: any },
  specRef: { id: string; url: string },
  details: Record<string, unknown>
): ConformanceCheck {
  const errors: string[] = [];
  if (response.status >= 400) {
    errors.push(
      `Expected successful response, got HTTP ${response.status}. Server MUST accept this request.`
    );
  }
  // A server can return HTTP 200 with a JSON-RPC error in the body. Without
  // this assertion that case would pass as "accepted".
  if (
    response.body &&
    typeof response.body === 'object' &&
    'error' in response.body
  ) {
    errors.push(
      `Expected successful response, but body contains JSON-RPC error ${JSON.stringify(response.body.error)}.`
    );
  }
  return {
    id,
    name,
    description,
    status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    specReferences: [specRef],
    details: {
      ...details,
      responseStatus: response.status,
      responseBody: response.body
    }
  };
}

export class HttpHeaderValidationScenario implements ClientScenario {
  name = 'http-header-validation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test server validation of standard MCP request headers (SEP-2243).

**Server Implementation Requirements:**

**Endpoint**: Streamable HTTP

**Requirements**:
- Server MUST reject requests where Mcp-Method header doesn't match the body method
- Server MUST reject requests where Mcp-Name header doesn't match the body params.name/uri
- Server MUST accept header names case-insensitively
- Server MUST reject case-mismatched header values (method values are case-sensitive)
- Server MUST accept extra whitespace around header values (per HTTP spec)
- Server MUST return HTTP 400 Bad Request for validation failures
- Server MUST return JSON-RPC error with code -32020 (HeaderMismatch)`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl } = ctx;
    const checks: ConformanceCheck[] = [];

    try {
      // Discover the server's tools with a fully-conformant stateless request
      // (SEP-2575) — that wire protocol has no initialize handshake or sessions.
      const toolsResponse = await sendStatelessRequest(serverUrl, 'tools/list');
      if (!toolsResponse.body?.result) {
        // The server under test could not even answer a conformant tools/list:
        // report a single explicit setup failure instead of misleading
        // per-case results against a broken server.
        const rpcError = toolsResponse.body?.error;
        checks.push({
          id: 'sep-2243-server-standard-setup',
          name: 'HttpHeaderValidationSetup',
          description: 'Setup for header validation tests',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            `tools/list discovery failed: HTTP ${toolsResponse.status}` +
            (rpcError
              ? `, JSON-RPC error ${rpcError.code}: ${rpcError.message}`
              : ', no result in response body'),
          specReferences: [SPEC_REFERENCE],
          details: { httpStatus: toolsResponse.status, error: rpcError }
        });
        return checks;
      }
      const toolsResult = toolsResponse.body.result as {
        tools?: Array<{ name: string; inputSchema?: unknown }>;
      };

      const baseHeaders: Record<string, string> = {
        'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION
      };

      let idCounter = 100;
      const nextId = () => idCounter++;

      // --- Header/Body Mismatch Tests ---

      await this.testCase(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'reject',
        REJECT_STATUS_CHECK_ID,
        'ServerRejectsMismatchedMethodHeader',
        'Server rejects requests where Mcp-Method header does not match body method',
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        { 'Mcp-Method': 'prompts/list' },
        SPEC_REFERENCE,
        { requestBodyMethod: 'tools/list', mcpMethodHeader: 'prompts/list' }
      );

      await this.testCase(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'reject',
        REJECT_STATUS_CHECK_ID,
        'ServerRejectsMissingMethodHeader',
        'Server rejects requests with missing Mcp-Method header',
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        {},
        SPEC_REFERENCE,
        { requestBodyMethod: 'tools/list', mcpMethodHeader: '(missing)' }
      );

      if (toolsResult.tools && toolsResult.tools.length > 0) {
        const toolName = toolsResult.tools[0].name;

        await this.testCase(
          checks,
          serverUrl,
          baseHeaders,
          nextId,
          'reject',
          REJECT_STATUS_CHECK_ID,
          'ServerRejectsMismatchedNameHeader',
          'Server rejects tools/call where Mcp-Name does not match body params.name',
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/call',
            params: { name: toolName, arguments: {} }
          },
          { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'wrong_tool_name' },
          SPEC_REFERENCE,
          { requestBodyName: toolName, mcpNameHeader: 'wrong_tool_name' }
        );

        // --- Whitespace Test ---

        await this.testCase(
          checks,
          serverUrl,
          baseHeaders,
          nextId,
          'accept',
          'sep-2243-server-accepts-whitespace-header-value',
          'ServerAcceptsWhitespaceHeaderValue',
          'Server MUST accept leading/trailing whitespace in Mcp-Name value (RFC 9110 §5.5: field parsing MUST exclude OWS before evaluating)',
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/call',
            params: { name: toolName, arguments: {} }
          },
          {
            'Mcp-Method': 'tools/call',
            'Mcp-Name': `  ${toolName}  `
          },
          SPEC_REFERENCE_RFC9110_OWS,
          {
            headerValue: `  ${toolName}  `,
            bodyValue: toolName,
            reason: 'HTTP spec requires trimming OWS around field values'
          }
        );

        // --- Missing Standard Header with Value in Body (Case 47) ---

        await this.testCase(
          checks,
          serverUrl,
          baseHeaders,
          nextId,
          'reject',
          REJECT_STATUS_CHECK_ID,
          'ServerRejectsMissingNameHeader',
          'Server MUST reject tools/call with missing Mcp-Name header when body has params.name',
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/call',
            params: { name: toolName, arguments: {} }
          },
          { 'Mcp-Method': 'tools/call' },
          SPEC_REFERENCE,
          {
            requestBodyName: toolName,
            mcpNameHeader: '(missing)',
            reason:
              'Standard header omitted but value present in body → MUST reject'
          }
        );
      }

      // --- Case Sensitivity Tests ---

      await this.testCase(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'accept',
        'sep-2243-header-name-case-insensitive',
        'ServerAcceptsLowercaseHeaderName',
        'Server MUST accept lowercase header name (mcp-method)',
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        { 'mcp-method': 'tools/list' },
        SPEC_REFERENCE_CASE,
        { headerNameUsed: 'mcp-method' }
      );

      await this.testCase(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'accept',
        'sep-2243-header-name-case-insensitive',
        'ServerAcceptsUppercaseHeaderName',
        'Server MUST accept uppercase header name (MCP-METHOD)',
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        { 'MCP-METHOD': 'tools/list' },
        SPEC_REFERENCE_CASE,
        { headerNameUsed: 'MCP-METHOD' }
      );

      await this.testCase(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'reject',
        REJECT_STATUS_CHECK_ID,
        'ServerRejectsCaseMismatchValue',
        'Server MUST reject uppercase method value (TOOLS/LIST) since values are case-sensitive',
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        { 'Mcp-Method': 'TOOLS/LIST' },
        SPEC_REFERENCE_CASE,
        { headerValue: 'TOOLS/LIST', bodyValue: 'tools/list' }
      );
    } catch (error) {
      checks.push({
        id: 'sep-2243-server-standard-setup',
        name: 'HttpHeaderValidationSetup',
        description: 'Setup for header validation tests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to set up tests: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE]
      });
    }

    return checks;
  }

  private async testCase(
    checks: ConformanceCheck[],
    serverUrl: string,
    baseHeaders: Record<string, string>,
    nextId: () => number,
    expectation: 'accept' | 'reject',
    checkId: string,
    checkName: string,
    description: string,
    body: any,
    extraHeaders: Record<string, string>,
    specRef: { id: string; url: string },
    details: Record<string, unknown>
  ): Promise<void> {
    try {
      // Issue #311: every raw request carries the SEP-2575 _meta fields — the
      // header-validation cases only mangle headers, never the body metadata.
      const requestBody = {
        ...body,
        id: body.id === 0 ? nextId() : body.id,
        params: withRequestMeta(body.params)
      };
      const response = await sendRawRequest(serverUrl, requestBody, {
        ...baseHeaders,
        ...extraHeaders
      });
      if (expectation === 'reject') {
        // Standard-header rejection: 400 is MUST, -32020 is SHOULD. All
        // standard-header rejection cases collapse onto the coarse requirement
        // ids; checkId/checkName still distinguish the case via name/details.
        checks.push(
          ...createRejectionChecks(
            REJECT_STATUS_CHECK_ID,
            REJECT_ERROR_CODE_CHECK_ID,
            checkName,
            description,
            response,
            specRef,
            details,
            { errorCodeSeverity: 'WARNING' }
          )
        );
      } else {
        checks.push(
          createAcceptanceCheck(
            checkId,
            checkName,
            description,
            response,
            specRef,
            details
          )
        );
      }
    } catch (error) {
      checks.push({
        id: checkId,
        name: checkName,
        description,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [specRef]
      });
    }
  }
}

export class HttpCustomHeaderServerValidationScenario implements ClientScenario {
  name = 'http-custom-header-server-validation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test server validation of custom Mcp-Param headers and Base64 encoding (SEP-2243).

**Server Implementation Requirements:**

**Endpoint**: Streamable HTTP with at least one tool using \`x-mcp-header\`

**Requirements**:
- Server MUST validate Base64-encoded header values
- Server MUST reject requests with invalid Base64 padding or characters
- Server MUST treat values without =?base64?...?= wrapper as literal
- Server MUST reject requests where custom header is omitted but value is in body`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl } = ctx;
    const checks: ConformanceCheck[] = [];

    try {
      // Discover the server's tools with a fully-conformant stateless request
      // (SEP-2575) — that wire protocol has no initialize handshake or sessions.
      const toolsResponse = await sendStatelessRequest(serverUrl, 'tools/list');
      if (!toolsResponse.body?.result) {
        // The server under test could not even answer a conformant tools/list:
        // report a single explicit setup failure (and backfill the declared
        // checks, mirroring the catch path) instead of pretending the
        // requirements are not applicable to a broken server.
        const rpcError = toolsResponse.body?.error;
        checks.push({
          id: 'sep-2243-server-custom-setup',
          name: 'HttpCustomHeaderServerValidationSetup',
          description: 'Setup for custom header server validation tests',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            `tools/list discovery failed: HTTP ${toolsResponse.status}` +
            (rpcError
              ? `, JSON-RPC error ${rpcError.code}: ${rpcError.message}`
              : ', no result in response body'),
          specReferences: [SPEC_REFERENCE_CUSTOM],
          details: { httpStatus: toolsResponse.status, error: rpcError }
        });
        this.failDeclaredChecks(checks);
        return checks;
      }
      const toolsResult = toolsResponse.body.result as {
        tools?: Array<{ name: string; inputSchema?: unknown }>;
      };

      // Find a tool with x-mcp-header annotations
      const xMcpTool = toolsResult.tools?.find((tool) => {
        const schema = tool.inputSchema as any;
        if (!schema?.properties) return false;
        return Object.values(schema.properties).some(
          (prop: any) => prop['x-mcp-header'] !== undefined
        );
      });

      if (!xMcpTool) {
        checks.push({
          id: 'sep-2243-server-no-xmcp-tool',
          name: 'HttpCustomHeaderServerNoTool',
          description:
            'Server has no tools with x-mcp-header annotations to test',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          specReferences: [SPEC_REFERENCE_CUSTOM],
          details: {
            reason:
              'No tools with x-mcp-header found. These tests require at least one tool with x-mcp-header annotations.'
          }
        });
        this.skipDeclaredChecks(
          checks,
          'Server exposes no tool with x-mcp-header annotations.'
        );
        return checks;
      }

      const baseHeaders: Record<string, string> = {
        'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION
      };

      // Find the first x-mcp-header annotated STRING property
      // that is callable with minimal arguments to avoid schema validation failures
      const schema = xMcpTool.inputSchema as any;
      const annotatedEntry = Object.entries(schema.properties).find(
        ([, def]: [string, any]) =>
          def['x-mcp-header'] !== undefined && (def as any).type === 'string'
      );
      if (!annotatedEntry) {
        checks.push({
          id: 'sep-2243-server-no-string-param',
          name: 'HttpCustomHeaderServerNoStringParam',
          description:
            'Server has no string-typed x-mcp-header parameter to test',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          specReferences: [SPEC_REFERENCE_CUSTOM]
        });
        this.skipDeclaredChecks(
          checks,
          'Server exposes no string-typed x-mcp-header parameter.'
        );
        return checks;
      }
      const [paramName, paramDef] = annotatedEntry as [string, any];
      const headerSuffix = paramDef['x-mcp-header'];

      // Build default arguments for all required params to avoid schema validation errors.
      // These go in the JSON body, so number/boolean must be the real types —
      // sending '0' or 'false' as strings makes the server reject on JSON-schema
      // grounds and the header-validation checks below would false-pass on that 400.
      const requiredParams: string[] = schema.required || [];
      const defaultArgs: Record<string, string | number | boolean> = {};
      const defaultHeaders: Record<string, string> = {};
      for (const rp of requiredParams) {
        if (rp !== paramName) {
          const rpDef = schema.properties[rp];
          const rpType = rpDef?.type || 'string';
          if (rpType === 'number' || rpType === 'integer') {
            defaultArgs[rp] = 0;
          } else if (rpType === 'boolean') {
            defaultArgs[rp] = false;
          } else {
            defaultArgs[rp] = 'test-default';
          }
          // If this required param also has x-mcp-header, include its header too
          if (rpDef?.['x-mcp-header']) {
            defaultHeaders[`Mcp-Param-${rpDef['x-mcp-header']}`] = String(
              defaultArgs[rp]
            );
          }
        }
      }

      let idCounter = 200;
      const nextId = () => idCounter++;

      // --- Base64 Decoding Tests ---

      const validBase64Value = Buffer.from('Hello').toString('base64');

      // Valid Base64 - server decodes and validates
      await this.testBase64Case(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'accept',
        'sep-2243-server-decode-base64',
        'ServerAcceptsValidBase64',
        'Server decodes valid Base64 header value and validates against body',
        xMcpTool.name,
        paramName,
        'Hello',
        headerSuffix,
        `=?base64?${validBase64Value}?=`,
        defaultArgs,
        defaultHeaders
      );

      // Invalid Base64 padding — FAILURE per the SEP-2243 conformance-test-case
      // table, which is the approved source of truth for these cases. The spec
      // body says only "MUST decode them accordingly", but the table specifies
      // strict rejection. SDKs whose stdlib decoders are lenient (Node
      // Buffer.from, browser atob) will need to validate before decoding; if
      // that proves burdensome we'll revisit.
      await this.testBase64Case(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'reject',
        'sep-2243-server-reject-invalid-param-chars',
        'ServerRejectsInvalidBase64Padding',
        'Server MUST reject Mcp-Param header with invalid Base64 padding (per SEP-2243 test-case table)',
        xMcpTool.name,
        paramName,
        'Hello',
        headerSuffix,
        '=?base64?SGVsbG8?=',
        defaultArgs,
        defaultHeaders
      );

      // Invalid Base64 characters — FAILURE for the same reason as padding.
      await this.testBase64Case(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'reject',
        'sep-2243-server-reject-invalid-param-chars',
        'ServerRejectsInvalidBase64Chars',
        'Server MUST reject Mcp-Param header with non-alphabet Base64 characters (per SEP-2243 test-case table)',
        xMcpTool.name,
        paramName,
        'Hello',
        headerSuffix,
        '=?base64?SGVs!!!bG8=?=',
        defaultArgs,
        defaultHeaders
      );

      // Missing prefix - server treats as literal value
      await this.testBase64Case(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'accept',
        'sep-2243-server-validate-param-match',
        'ServerLiteralMissingBase64Prefix',
        'Server treats value without =?base64? prefix as literal (not Base64)',
        xMcpTool.name,
        paramName,
        validBase64Value,
        headerSuffix,
        validBase64Value,
        defaultArgs,
        defaultHeaders
      );

      // Missing suffix - server treats as literal value
      await this.testBase64Case(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        'accept',
        'sep-2243-server-validate-param-match',
        'ServerLiteralMissingBase64Suffix',
        'Server treats value without ?= suffix as literal (not Base64)',
        xMcpTool.name,
        paramName,
        `=?base64?${validBase64Value}`,
        headerSuffix,
        `=?base64?${validBase64Value}`,
        defaultArgs,
        defaultHeaders
      );

      // --- Missing Custom Header with Value in Body ---

      await this.testMissingCustomHeader(
        checks,
        serverUrl,
        baseHeaders,
        nextId,
        xMcpTool.name,
        paramName,
        headerSuffix,
        defaultArgs,
        defaultHeaders
      );
    } catch (error) {
      checks.push({
        id: 'sep-2243-server-custom-setup',
        name: 'HttpCustomHeaderServerValidationSetup',
        description: 'Setup for custom header server validation tests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    }

    // Declared-but-unemitted -> FAILURE. Reached only when setup threw partway
    // through (the gate-out paths emit SKIPPED rows and the happy path emits
    // every declared ID).
    this.failDeclaredChecks(checks);

    return checks;
  }

  /**
   * Backfill every declared-but-unemitted check ID as FAILURE when setup
   * failed before the cases could run, keeping the emitted ID set stable.
   */
  private failDeclaredChecks(checks: ConformanceCheck[]): void {
    for (const id of CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS) {
      if (checks.some((c) => c.id === id)) continue;
      checks.push({
        id,
        name: 'NotObserved',
        description: `Declared check ${id} was never emitted`,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          'Check was not observed: custom-header validation setup failed before this case ran.',
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    }
  }

  /**
   * Emit one SKIPPED row per declared requirement check when the scenario
   * cannot run against this server (no x-mcp-header tool). The IDs must still
   * reach checks.json so the traceability manifest records that a scenario
   * exists for each requirement.
   */
  private skipDeclaredChecks(checks: ConformanceCheck[], reason: string): void {
    for (const id of CUSTOM_HEADER_SERVER_DECLARED_CHECK_IDS) {
      if (checks.some((c) => c.id === id)) continue;
      checks.push({
        id,
        name: 'NotApplicable',
        description: `Declared check ${id} is not testable against this server`,
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        specReferences: [SPEC_REFERENCE_CUSTOM],
        details: { reason }
      });
    }
  }

  private async testBase64Case(
    checks: ConformanceCheck[],
    serverUrl: string,
    baseHeaders: Record<string, string>,
    nextId: () => number,
    expectation: 'accept' | 'reject',
    checkId: string,
    checkName: string,
    description: string,
    toolName: string,
    paramName: string,
    bodyValue: string,
    headerSuffix: string,
    headerValue: string,
    defaultArgs: Record<string, any>,
    defaultHeaders: Record<string, string>
  ): Promise<void> {
    try {
      const response = await sendRawRequest(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: nextId(),
          method: 'tools/call',
          // Issue #311: the body always carries the SEP-2575 _meta fields —
          // these cases only vary the Mcp-Param header value.
          params: withRequestMeta({
            name: toolName,
            arguments: { ...defaultArgs, [paramName]: bodyValue }
          })
        },
        {
          ...baseHeaders,
          ...defaultHeaders,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': toolName,
          [`Mcp-Param-${headerSuffix}`]: headerValue
        }
      );

      const details = {
        toolName,
        paramName,
        bodyValue,
        headerSuffix,
        headerValue
      };

      if (expectation === 'accept') {
        checks.push(
          createAcceptanceCheck(
            checkId,
            checkName,
            description,
            response,
            SPEC_REFERENCE_BASE64,
            details
          )
        );
      } else {
        // Custom-header rejection: both 400 and -32020 are MUST per
        // §Server Behavior for Custom Headers. The status half maps to the
        // param-validation requirement this case exercises (checkId); the
        // error-code half is the "400 + -32020 if any validation fails"
        // requirement.
        checks.push(
          ...createRejectionChecks(
            checkId,
            PARAM_REJECT_ERROR_CODE_CHECK_ID,
            checkName,
            description,
            response,
            SPEC_REFERENCE_BASE64,
            details,
            { errorCodeSeverity: 'FAILURE' }
          )
        );
      }
    } catch (error) {
      checks.push({
        id: checkId,
        name: checkName,
        description,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE_BASE64]
      });
    }
  }

  private async testMissingCustomHeader(
    checks: ConformanceCheck[],
    serverUrl: string,
    baseHeaders: Record<string, string>,
    nextId: () => number,
    toolName: string,
    paramName: string,
    headerSuffix: string,
    defaultArgs: Record<string, any>,
    defaultHeaders: Record<string, string>
  ): Promise<void> {
    try {
      // Send tools/call with value in body but NO Mcp-Param header
      const response = await sendRawRequest(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: nextId(),
          method: 'tools/call',
          // Issue #311: the body always carries the SEP-2575 _meta fields —
          // this case only omits the Mcp-Param header.
          params: withRequestMeta({
            name: toolName,
            arguments: { ...defaultArgs, [paramName]: 'test-value' }
          })
        },
        {
          ...baseHeaders,
          ...defaultHeaders,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': toolName
          // Deliberately omit Mcp-Param-{headerSuffix} header
        }
      );

      // Custom-header rejection: both 400 and -32020 are MUST. A header
      // omitted while the body carries a value is a header/body mismatch, so
      // the status half maps to the validate-param-match requirement.
      checks.push(
        ...createRejectionChecks(
          'sep-2243-server-validate-param-match',
          PARAM_REJECT_ERROR_CODE_CHECK_ID,
          'ServerRejectsMissingCustomHeader',
          'Server MUST reject request where custom header is omitted but value is present in body',
          response,
          SPEC_REFERENCE_CUSTOM,
          {
            toolName,
            paramName,
            bodyValue: 'test-value',
            expectedHeader: `Mcp-Param-${headerSuffix}`,
            mcpParamHeader: '(missing)'
          },
          { errorCodeSeverity: 'FAILURE' }
        )
      );
    } catch (error) {
      checks.push({
        id: 'sep-2243-server-validate-param-match',
        name: 'ServerRejectsMissingCustomHeader',
        description:
          'Server MUST reject request where custom header is omitted but value is present in body',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE_CUSTOM]
      });
    }
  }
}
