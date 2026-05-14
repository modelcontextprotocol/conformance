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
import {
  Scenario,
  ScenarioUrls,
  ConformanceCheck,
  SpecVersion
} from '../../types.js';

const SPEC_REFERENCE = {
  id: 'SEP-2243-Standard-Headers',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#standard-mcp-request-headers'
};

export class HttpStandardHeadersScenario implements Scenario {
  name = 'http-standard-headers';
  specVersions: SpecVersion[] = ['DRAFT-2026-v1'];
  description =
    'Tests that client includes Mcp-Method and Mcp-Name headers on HTTP POST requests (SEP-2243)';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private port: number = 0;
  private sessionId: string = `session-${Date.now()}`;

  // Track which header checks have been recorded
  private methodHeaderChecks = new Map<string, boolean>();
  // Track which Mcp-Name checks have been recorded
  private nameHeaderChecks = new Map<string, boolean>();

  async start(): Promise<ScenarioUrls> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(0, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve({
            serverUrl: `http://localhost:${this.port}`
          });
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) reject(err);
          else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  getChecks(): ConformanceCheck[] {
    // Build a fresh array each call so getChecks() is idempotent — the runner
    // may call it more than once and we must not accumulate duplicates.
    const result = [...this.checks];

    // SEP-2243 requires Mcp-Method on "all requests and notifications". A
    // client that never sent prompts/list isn't violating SEP-2243 — it just
    // didn't exercise that path. Emit SKIPPED (not FAILURE) so a prompts-less
    // client doesn't show red, but the gap is still visible in the report.
    const expectedMethods = [
      'initialize',
      'notifications/initialized',
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
          id: `client-mcp-method-header-${method.replace('/', '-')}`,
          name: `ClientMcpMethodHeader_${method.replace('/', '_')}`,
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
          id: `client-mcp-name-header-${method.replace('/', '-')}`,
          name: `ClientMcpNameHeader_${method.replace('/', '_')}`,
          description: `Client sends correct Mcp-Name header on ${method} request`,
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage: `Client did not send a ${method} request; Mcp-Name header was not exercised for this method.`,
          specReferences: [SPEC_REFERENCE]
        });
      }
    }

    return result;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (req.method !== 'POST') {
      // Handle GET for SSE resumability - just close
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'mcp-session-id': this.sessionId
        });
        res.write('data: \n\n');
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const request = JSON.parse(body);

        // Check Mcp-Method header for every request
        this.checkMcpMethodHeader(req, request);

        // Route to handlers
        if (request.method === 'initialize') {
          this.handleInitialize(res, request);
        } else if (request.method === 'tools/list') {
          this.handleToolsList(res, request);
        } else if (request.method === 'tools/call') {
          this.checkMcpNameHeader(req, request, 'params.name');
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
          // Notifications - return 202 (Mcp-Method already checked above)
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-session-id': this.sessionId
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {}
            })
          );
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: `Parse error: ${error}`
            }
          })
        );
      }
    });
  }

  private checkMcpMethodHeader(req: http.IncomingMessage, request: any): void {
    const method = request.method;
    if (!method) return;

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
      id: `client-mcp-method-header-${method.replace('/', '-')}`,
      name: `ClientMcpMethodHeader_${method.replace('/', '_')}`,
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
      id: `client-mcp-name-header-${method.replace('/', '-')}`,
      name: `ClientMcpNameHeader_${method.replace('/', '_')}`,
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

  private handleInitialize(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: 'DRAFT-2026-v1',
          serverInfo: {
            name: 'http-standard-headers-test-server',
            version: '1.0.0'
          },
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          }
        }
      })
    );
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
          messages: []
        }
      })
    );
  }
}
