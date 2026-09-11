/**
 * HTTP Standard Headers conformance test scenario for MCP clients (SEP-2243)
 *
 * Tests that clients include the required standard MCP request headers on
 * Streamable HTTP POST requests:
 * - `Mcp-Method`: mirrors the `method` field from the JSON-RPC request body
 * - `Mcp-Name`: mirrors `params.name` or `params.uri` for tools/call,
 *   resources/read, and prompts/get requests
 *
 * This is a Scenario (acts as a test server that inspects incoming requests
 * from the client under test).
 */

import http from 'http';
import { ConformanceCheck } from '../../types.js';
import { BaseHttpScenario } from './http-base.js';

const SPEC_REFERENCE = {
  id: 'SEP-2243-Standard-Headers',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#standard-mcp-request-headers'
};

const SPEC_REFERENCE_ENCODING = {
  id: 'SEP-2243-Value-Encoding',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#value-encoding'
};

/**
 * Tool name containing non-ASCII characters. Tool/prompt names are only
 * SHOULD-constrained to header-safe characters, so a name outside the safe
 * set MUST be carried in `Mcp-Name` via the Base64 sentinel encoding.
 */
const UNICODE_TOOL_NAME = 'tööl_unicode';

export class HttpStandardHeadersScenario extends BaseHttpScenario {
  name = 'http-standard-headers';
  description =
    'Tests that client includes Mcp-Method and Mcp-Name headers on HTTP POST requests (SEP-2243)';

  // Track which header checks have been recorded
  private methodHeaderChecks = new Map<string, boolean>();
  // Track which Mcp-Name checks have been recorded
  private nameHeaderChecks = new Map<string, boolean>();
  // Track whether the non-header-safe tool was called (Base64 Mcp-Name check)
  private unicodeToolCallReceived = false;

  getChecks(): ConformanceCheck[] {
    // Build a fresh array each call so getChecks() is idempotent — the runner
    // may call it more than once and we must not accumulate duplicates.
    const result = [...this.checks];

    // SEP-2243 requires Mcp-Method on "all requests". A client that never sent
    // prompts/list isn't violating SEP-2243 — it just didn't exercise that
    // path. Emit SKIPPED (not FAILURE) so a prompts-less client doesn't show
    // red, but the gap is still visible in the report. Notifications are NOT
    // listed: header rules for notification POSTs are explicitly undefined.
    const expectedMethods = [
      'initialize',
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/read',
      'prompts/list',
      'prompts/get'
    ];

    for (const method of expectedMethods) {
      if (!this.methodHeaderChecks.has(method)) {
        result.push({
          id: 'sep-2243-client-includes-standard-headers',
          name: `ClientMcpMethodHeader_${method.replace(/\//g, '_')}`,
          description: `Client sends correct Mcp-Method header on ${method} request`,
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage: `Client did not send a ${method} request; Mcp-Method header was not exercised for this method.`,
          specReferences: [SPEC_REFERENCE]
        });
      }
    }

    const expectedNameMethods = ['tools/call', 'resources/read', 'prompts/get'];
    for (const method of expectedNameMethods) {
      if (!this.nameHeaderChecks.has(method)) {
        result.push({
          id: 'sep-2243-client-includes-standard-headers',
          name: `ClientMcpNameHeader_${method.replace(/\//g, '_')}`,
          description: `Client sends correct Mcp-Name header on ${method} request`,
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage: `Client did not send a ${method} request; Mcp-Name header was not exercised for this method.`,
          specReferences: [SPEC_REFERENCE]
        });
      }
    }

    if (!this.unicodeToolCallReceived) {
      result.push({
        id: 'sep-2243-client-base64-mcp-name',
        name: 'ClientMcpNameHeaderBase64',
        description:
          'Client Base64-encodes Mcp-Name when the source value is not header-safe',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: `Client did not call '${UNICODE_TOOL_NAME}'; Base64 Mcp-Name encoding was not exercised.`,
        specReferences: [SPEC_REFERENCE_ENCODING]
      });
    }

    return result;
  }

  protected handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    // Check Mcp-Method header for every request (notifications excluded —
    // header rules for notification POSTs are explicitly undefined by the spec)
    this.checkMcpMethodHeader(req, request);

    // Route to handlers
    if (request.method === 'initialize') {
      this.handleInitialize(res, request);
    } else if (request.method === 'tools/list') {
      this.handleToolsList(res, request);
    } else if (request.method === 'tools/call') {
      if (request.params?.name === UNICODE_TOOL_NAME) {
        // Non-header-safe name → check Base64 sentinel encoding instead of
        // the plain Mcp-Name comparison (which would mismatch by design).
        this.checkMcpNameBase64Header(req, request);
      } else {
        this.checkMcpNameHeader(req, request, 'params.name');
      }
      this.handleToolsCall(res, request);
    } else if (request.method === 'resources/list') {
      this.handleResourcesList(res, request);
    } else if (request.method === 'resources/read') {
      this.checkMcpNameHeader(req, request, 'params.uri');
      this.handleResourcesRead(res, request);
    } else if (request.method === 'prompts/list') {
      this.handlePromptsList(res, request);
    } else if (request.method === 'prompts/get') {
      this.checkMcpNameHeader(req, request, 'params.name');
      this.handlePromptsGet(res, request);
    } else if (request.id === undefined) {
      // Notifications - return 202 (Mcp-Method not required on notifications)
      this.sendNotificationAck(res);
    } else {
      this.sendGenericResult(res, request);
    }
  }

  private checkMcpMethodHeader(req: http.IncomingMessage, request: any): void {
    const method = request.method;
    if (!method) return;

    // Mcp-Method is required on requests only; header rules for notification
    // POSTs are explicitly undefined by the spec, so a missing Mcp-Method on
    // a notification (no JSON-RPC id) is neither SUCCESS nor FAILURE.
    if (request.id === undefined) return;

    // Already recorded a check for this method
    if (this.methodHeaderChecks.has(method)) return;

    // Header names are lowercased by Node.js http parser
    const mcpMethodHeader = req.headers['mcp-method'] as string | undefined;

    const errors: string[] = [];
    if (!mcpMethodHeader) {
      errors.push(
        `Missing Mcp-Method header on ${method} request. Clients MUST include the Mcp-Method header on all POST requests.`
      );
    } else if (mcpMethodHeader !== method) {
      // Header values are case-sensitive
      errors.push(
        `Mcp-Method header value '${mcpMethodHeader}' does not match body method '${method}'. Header values are case-sensitive.`
      );
    }

    this.methodHeaderChecks.set(method, errors.length === 0);

    this.checks.push({
      id: 'sep-2243-client-includes-standard-headers',
      name: `ClientMcpMethodHeader_${method.replace(/\//g, '_')}`,
      description: `Client sends correct Mcp-Method header on ${method} request`,
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: [SPEC_REFERENCE],
      details: {
        expectedMethod: method,
        actualHeader: mcpMethodHeader
      }
    });
  }

  private checkMcpNameHeader(
    req: http.IncomingMessage,
    request: any,
    sourceField: string
  ): void {
    const method = request.method;

    // Same de-dup guard as checkMcpMethodHeader: the harness advertises two
    // tools and two resources, so a client that calls both would otherwise
    // produce duplicate check rows for the same id.
    if (this.nameHeaderChecks.has(method)) return;

    const expectedValue =
      sourceField === 'params.uri' ? request.params?.uri : request.params?.name;

    const mcpNameHeader = req.headers['mcp-name'] as string | undefined;

    const errors: string[] = [];
    if (!mcpNameHeader) {
      errors.push(
        `Missing Mcp-Name header on ${method} request. Clients MUST include the Mcp-Name header for ${method} requests.`
      );
    } else if (mcpNameHeader !== expectedValue) {
      errors.push(
        `Mcp-Name header value '${mcpNameHeader}' does not match body ${sourceField} '${expectedValue}'.`
      );
    }

    this.nameHeaderChecks.set(method, errors.length === 0);

    this.checks.push({
      id: 'sep-2243-client-includes-standard-headers',
      name: `ClientMcpNameHeader_${method.replace(/\//g, '_')}`,
      description: `Client sends correct Mcp-Name header on ${method} request`,
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: [SPEC_REFERENCE],
      details: {
        method,
        sourceField,
        expectedValue,
        actualHeader: mcpNameHeader
      }
    });
  }

  private checkMcpNameBase64Header(
    req: http.IncomingMessage,
    request: any
  ): void {
    // Record once: subsequent calls to the same unicode tool are ignored so
    // getChecks() stays idempotent.
    if (this.unicodeToolCallReceived) return;
    this.unicodeToolCallReceived = true;

    const bodyName = request.params?.name as string;
    const mcpNameHeader = req.headers['mcp-name'] as string | undefined;
    const expectedHeader = `=?base64?${Buffer.from(bodyName, 'utf-8').toString('base64')}?=`;

    const errors: string[] = [];
    if (!mcpNameHeader) {
      errors.push(
        `Missing Mcp-Name header on tools/call for '${bodyName}'. Clients MUST include the Mcp-Name header for tools/call requests.`
      );
    } else {
      const base64Match = mcpNameHeader.match(/^=\?base64\?(.*)\?=$/);
      if (!base64Match) {
        errors.push(
          `Mcp-Name source value '${bodyName}' is not header-safe but header was sent unencoded as '${mcpNameHeader}'. Clients MUST encode it using the Base64 sentinel format =?base64?{encoded}?=.`
        );
      } else {
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8');
        if (decoded !== bodyName) {
          errors.push(
            `Base64-decoded Mcp-Name '${decoded}' (raw: '${mcpNameHeader}') does not match body params.name '${bodyName}'.`
          );
        }
      }
    }

    this.checks.push({
      id: 'sep-2243-client-base64-mcp-name',
      name: 'ClientMcpNameHeaderBase64',
      description:
        'Client Base64-encodes Mcp-Name when the source value is not header-safe',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: [SPEC_REFERENCE_ENCODING],
      details: {
        bodyName,
        actualHeader: mcpNameHeader,
        expectedHeader
      }
    });
  }

  protected discoverCapabilities(): object {
    return { tools: {}, resources: {}, prompts: {} };
  }

  private handleInitialize(res: http.ServerResponse, request: any): void {
    this.sendInitialize(res, request);
  }

  private handleToolsList(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: [
            {
              name: 'test_headers',
              description:
                'A simple tool used to test that HTTP headers are sent correctly',
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            },
            {
              name: 'my-hyphenated-tool',
              description:
                'Tool with hyphen in name to test special chars in Mcp-Name header',
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            },
            {
              name: UNICODE_TOOL_NAME,
              description:
                'Tool with non-ASCII name to test Base64 sentinel encoding of Mcp-Name header',
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            }
          ]
        }
      })
    );
  }

  private handleToolsCall(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          content: [
            {
              type: 'text',
              text: 'Headers test completed'
            }
          ]
        }
      })
    );
  }

  private handleResourcesList(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          resources: [
            {
              uri: 'file:///path/to/file%20name.txt',
              name: 'File with spaces',
              description: 'Resource URI with percent-encoded spaces'
            },
            {
              uri: 'https://example.com/resource?id=123',
              name: 'Resource with query string',
              description: 'Resource URI with query string'
            }
          ]
        }
      })
    );
  }

  private handleResourcesRead(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          contents: []
        }
      })
    );
  }

  private handlePromptsList(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          prompts: [
            {
              name: 'test_prompt',
              description: 'A simple prompt for header testing'
            }
          ]
        }
      })
    );
  }

  private handlePromptsGet(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resultType: 'complete',
          messages: []
        }
      })
    );
  }
}
