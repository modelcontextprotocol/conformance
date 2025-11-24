/**
 * SSE Retry conformance test scenarios for MCP clients (SEP-1699)
 *
 * Tests that clients properly respect the SSE retry field by:
 * - Waiting the specified milliseconds before reconnecting
 * - Sending Last-Event-ID header on reconnection
 * - Treating graceful stream closure as reconnectable
 */

import http from 'http';
import { Scenario, ScenarioUrls, ConformanceCheck } from '../../types.js';

export class SSERetryScenario implements Scenario {
  name = 'sse-retry';
  description =
    'Tests that client respects SSE retry field timing and reconnects properly (SEP-1699)';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private port: number = 0;

  // Timing tracking
  private toolStreamCloseTime: number | null = null;
  private getReconnectionTime: number | null = null;
  private getConnectionCount: number = 0;
  private lastEventIds: (string | undefined)[] = [];
  private retryValue: number = 500; // 500ms
  private eventIdCounter: number = 0;
  private sessionId: string = `session-${Date.now()}`;

  // Pending tool call to respond to after reconnection
  private pendingToolCallId: number | string | null = null;
  private getResponseStream: http.ServerResponse | null = null;

  // Tolerances for timing validation
  private readonly EARLY_TOLERANCE = 50; // Allow 50ms early for scheduler variance
  private readonly LATE_TOLERANCE = 200; // Allow 200ms late for network/event loop
  private readonly VERY_LATE_MULTIPLIER = 2; // If >2x retry value, client is likely ignoring it

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
          if (err) {
            reject(err);
          } else {
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
    // Generate checks based on observed behavior
    this.generateChecks();
    return this.checks;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (req.method === 'GET') {
      // Track GET reconnection timing and Last-Event-ID
      this.getConnectionCount++;
      this.getReconnectionTime = performance.now();

      const lastEventId = req.headers['last-event-id'] as string | undefined;
      const description = lastEventId
        ? `Received GET request for ${req.url} (Last-Event-ID: ${lastEventId})`
        : `Received GET request for ${req.url}`;
      this.checks.push({
        id: 'incoming-request',
        name: 'IncomingRequest',
        description,
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: {
          method: 'GET',
          url: req.url,
          headers: req.headers,
          connectionCount: this.getConnectionCount
        }
      });

      if (lastEventId) {
        this.lastEventIds.push(lastEventId);
      }

      // Handle GET SSE stream request (reconnection)
      this.handleGetSSEStream(req, res);
    } else if (req.method === 'POST') {
      // Handle POST JSON-RPC requests
      this.handlePostRequest(req, res);
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  }

  private handleGetSSEStream(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'mcp-session-id': this.sessionId
    });

    // Generate event ID
    this.eventIdCounter++;
    const eventId = `event-${this.eventIdCounter}`;

    // Send priming event with ID and retry field
    const primingContent = `id: ${eventId}\nretry: ${this.retryValue}\ndata: \n\n`;
    res.write(primingContent);

    this.checks.push({
      id: 'outgoing-sse-event',
      name: 'OutgoingSseEvent',
      description: `Sent SSE priming event on GET stream (id: ${eventId}, retry: ${this.retryValue}ms)`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        eventId,
        retryMs: this.retryValue,
        eventType: 'priming',
        raw: primingContent
      }
    });

    // Store the GET stream to send pending tool response
    this.getResponseStream = res;

    // If we have a pending tool call, send the response now
    if (this.pendingToolCallId !== null) {
      const toolResponse = {
        jsonrpc: '2.0',
        id: this.pendingToolCallId,
        result: {
          content: [
            {
              type: 'text',
              text: 'Reconnection test completed successfully'
            }
          ]
        }
      };

      const responseEventId = `event-${++this.eventIdCounter}`;
      const responseContent = `event: message\nid: ${responseEventId}\ndata: ${JSON.stringify(toolResponse)}\n\n`;
      res.write(responseContent);

      this.checks.push({
        id: 'outgoing-sse-event',
        name: 'OutgoingSseEvent',
        description: `Sent tool response on GET stream after reconnection (id: ${responseEventId})`,
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: {
          eventId: responseEventId,
          eventType: 'message',
          jsonrpcId: this.pendingToolCallId,
          body: toolResponse,
          raw: responseContent
        }
      });

      this.pendingToolCallId = null;
    }
  }

  private handlePostRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const request = JSON.parse(body);

        this.checks.push({
          id: 'incoming-request',
          name: 'IncomingRequest',
          description: `Received POST request for ${req.url} (method: ${request.method})`,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          details: {
            method: 'POST',
            url: req.url,
            jsonrpcMethod: request.method,
            jsonrpcId: request.id
          }
        });

        if (request.method === 'initialize') {
          this.handleInitialize(req, res, request);
        } else if (request.method === 'tools/list') {
          this.handleToolsList(res, request);
        } else if (request.method === 'tools/call') {
          this.handleToolsCall(res, request);
        } else if (request.id === undefined) {
          // Notifications (no id) - return 202 Accepted
          res.writeHead(202);
          res.end();
        } else {
          // For other requests, send a simple JSON response
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

  private handleInitialize(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: {
          name: 'sse-retry-test-server',
          version: '1.0.0'
        },
        capabilities: {
          tools: {}
        }
      }
    };

    res.end(JSON.stringify(response));

    this.checks.push({
      id: 'outgoing-response',
      name: 'OutgoingResponse',
      description: `Sent initialize response`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        jsonrpcId: request.id,
        body: response
      }
    });
  }

  private handleToolsList(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });

    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'test_reconnection',
            description:
              'A tool that triggers SSE stream closure to test client reconnection behavior',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      }
    };

    res.end(JSON.stringify(response));

    this.checks.push({
      id: 'outgoing-response',
      name: 'OutgoingResponse',
      description: `Sent tools/list response`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        jsonrpcId: request.id,
        body: response
      }
    });
  }

  private handleToolsCall(res: http.ServerResponse, request: any): void {
    // Store the request ID so we can respond after reconnection
    this.pendingToolCallId = request.id;

    // Start SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'mcp-session-id': this.sessionId
    });

    // Send priming event with retry field
    this.eventIdCounter++;
    const primingEventId = `event-${this.eventIdCounter}`;
    const primingContent = `id: ${primingEventId}\nretry: ${this.retryValue}\ndata: \n\n`;
    res.write(primingContent);

    this.checks.push({
      id: 'outgoing-sse-event',
      name: 'OutgoingSseEvent',
      description: `Sent SSE priming event for tools/call (id: ${primingEventId}, retry: ${this.retryValue}ms)`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        eventId: primingEventId,
        retryMs: this.retryValue,
        eventType: 'priming',
        raw: primingContent
      }
    });

    // Close the stream after a short delay to trigger reconnection
    setTimeout(() => {
      this.toolStreamCloseTime = performance.now();
      this.checks.push({
        id: 'outgoing-stream-close',
        name: 'OutgoingStreamClose',
        description:
          'Closed tools/call SSE stream to trigger client reconnection',
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: {
          retryMs: this.retryValue,
          pendingToolCallId: this.pendingToolCallId
        }
      });
      res.end();
    }, 50);
  }

  private generateChecks(): void {
    // Check 1: Client should have reconnected via GET after tool call stream close
    if (this.getConnectionCount < 1) {
      this.checks.push({
        id: 'client-sse-graceful-reconnect',
        name: 'ClientGracefulReconnect',
        description:
          'Client reconnects via GET after SSE stream is closed gracefully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Client did not attempt GET reconnection after stream closure. Client should treat graceful stream close as reconnectable.`,
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          getConnectionCount: this.getConnectionCount,
          toolStreamCloseTime: this.toolStreamCloseTime,
          retryValue: this.retryValue
        }
      });
      return;
    }

    // Client did reconnect - SUCCESS for graceful reconnection
    this.checks.push({
      id: 'client-sse-graceful-reconnect',
      name: 'ClientGracefulReconnect',
      description:
        'Client reconnects via GET after SSE stream is closed gracefully',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'SEP-1699',
          url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
        }
      ],
      details: {
        getConnectionCount: this.getConnectionCount
      }
    });

    // Check 2: Client MUST respect retry field timing
    if (
      this.toolStreamCloseTime !== null &&
      this.getReconnectionTime !== null
    ) {
      const actualDelay = this.getReconnectionTime - this.toolStreamCloseTime;
      const minExpected = this.retryValue - this.EARLY_TOLERANCE;
      const maxExpected = this.retryValue + this.LATE_TOLERANCE;

      const tooEarly = actualDelay < minExpected;
      const slightlyLate = actualDelay > maxExpected;
      const veryLate =
        actualDelay > this.retryValue * this.VERY_LATE_MULTIPLIER;
      const withinTolerance = !tooEarly && !slightlyLate;

      let status: 'SUCCESS' | 'FAILURE' | 'WARNING' = 'SUCCESS';
      let errorMessage: string | undefined;

      if (tooEarly) {
        // Client reconnected too soon - MUST violation
        status = 'FAILURE';
        errorMessage = `Client reconnected too early (${actualDelay.toFixed(0)}ms instead of ${this.retryValue}ms). Client MUST respect the retry field and wait the specified time.`;
      } else if (veryLate) {
        // Client reconnected way too late - likely ignoring retry field entirely
        status = 'FAILURE';
        errorMessage = `Client reconnected very late (${actualDelay.toFixed(0)}ms instead of ${this.retryValue}ms). Client appears to be ignoring the retry field and using its own backoff strategy.`;
      } else if (slightlyLate) {
        // Client reconnected slightly late - not a spec violation but suspicious
        status = 'WARNING';
        errorMessage = `Client reconnected slightly late (${actualDelay.toFixed(0)}ms instead of ${this.retryValue}ms). This is acceptable but may indicate network delays.`;
      }

      this.checks.push({
        id: 'client-sse-retry-timing',
        name: 'ClientRespectsRetryField',
        description:
          'Client MUST respect the retry field, waiting the given number of milliseconds before attempting to reconnect',
        status,
        timestamp: new Date().toISOString(),
        errorMessage,
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          expectedRetryMs: this.retryValue,
          actualDelayMs: Math.round(actualDelay),
          minAcceptableMs: minExpected,
          maxAcceptableMs: maxExpected,
          veryLateThresholdMs: this.retryValue * this.VERY_LATE_MULTIPLIER,
          earlyToleranceMs: this.EARLY_TOLERANCE,
          lateToleranceMs: this.LATE_TOLERANCE,
          withinTolerance,
          tooEarly,
          slightlyLate,
          veryLate,
          getConnectionCount: this.getConnectionCount
        }
      });
    } else {
      this.checks.push({
        id: 'client-sse-retry-timing',
        name: 'ClientRespectsRetryField',
        description: 'Client MUST respect the retry field timing',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage:
          'Could not measure timing - tool stream close time or GET reconnection time not recorded',
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          toolStreamCloseTime: this.toolStreamCloseTime,
          getReconnectionTime: this.getReconnectionTime
        }
      });
    }

    // Check 3: Client SHOULD send Last-Event-ID header on reconnection
    const hasLastEventId =
      this.lastEventIds.length > 0 && this.lastEventIds[0] !== undefined;

    this.checks.push({
      id: 'client-sse-last-event-id',
      name: 'ClientSendsLastEventId',
      description:
        'Client SHOULD send Last-Event-ID header on reconnection for resumability',
      status: hasLastEventId ? 'SUCCESS' : 'WARNING',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'SEP-1699',
          url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
        }
      ],
      details: {
        hasLastEventId,
        lastEventIds: this.lastEventIds,
        getConnectionCount: this.getConnectionCount
      },
      errorMessage: !hasLastEventId
        ? 'Client did not send Last-Event-ID header on reconnection. This is a SHOULD requirement for resumability.'
        : undefined
    });
  }
}
