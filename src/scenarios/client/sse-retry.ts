import type { ScenarioContext } from '../../mock-server';
/**
 * SSE Retry conformance test scenarios for MCP clients (SEP-1699)
 *
 * Tests that clients properly respect the SSE retry field by:
 * - Waiting the specified milliseconds before reconnecting
 * - Sending Last-Event-ID header on reconnection
 * - Treating graceful stream closure as reconnectable
 */

import http from 'http';
import {
  Scenario,
  ScenarioUrls,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  RequestListener
} from '../../types.js';

/** A check's timestamp in ms since the epoch, or null. */
function wallClock(check: ConformanceCheck | undefined): number | null {
  const t = check ? Date.parse(check.timestamp) : NaN;
  return Number.isNaN(t) ? null : t;
}

export class SSERetryScenario implements Scenario {
  name = 'sse-retry';
  readonly source = {
    introducedIn: '2025-11-25',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description =
    'Tests that client respects SSE retry field timing and reconnects properly (SEP-1699)';
  /**
   * On a serverless host the GET that resumes the tool call can reach a
   * different process from the tool call itself, so which call is pending,
   * the next event id and the GET count are read from the log, which the
   * hosted server brings up to date before every request. In one process
   * the log says what memory does.
   */
  readonly answersFromLog = true;

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

  // Tolerance for timing validation (early side only; lateness is not gated)
  private readonly EARLY_TOLERANCE = 50; // Allow 50ms early for scheduler variance

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    this.toolStreamCloseTime = null;
    this.getReconnectionTime = null;
    this.getConnectionCount = 0;
    this.lastEventIds = [];
    this.eventIdCounter = 0;
    this.sessionId = `session-${Date.now()}`;
    this.pendingToolCallId = null;
    this.getResponseStream = null;
    return (req, res) => this.handleRequest(req, res);
  }

  async start(_ctx?: ScenarioContext): Promise<ScenarioUrls> {
    const listener = this.handler(() => `http://localhost:${this.port}`);
    return new Promise((resolve, reject) => {
      this.server = http.createServer(listener);
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
    // The session id the client was given, whichever process minted it.
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) this.sessionId = sid;

    if (req.method === 'GET') {
      // Track GET reconnection timing and Last-Event-ID
      this.getConnectionCount =
        Math.max(this.getConnectionCount, this.getsInLog().length) + 1;
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
    const eventId = this.nextEventId();

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

    // If we have a pending tool call, send the response now. The log says
    // which, so a process that did not see the tool call still answers it
    // and one that did does not answer it twice.
    const pendingId = this.pendingFromLog();
    if (pendingId !== null) {
      const toolResponse = {
        jsonrpc: '2.0',
        id: pendingId,
        result: {
          content: [
            {
              type: 'text',
              text: 'Reconnection test completed successfully'
            }
          ]
        }
      };

      const responseEventId = this.nextEventId();
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
          jsonrpcId: pendingId,
          body: toolResponse,
          raw: responseContent
        }
      });

      this.pendingToolCallId = null;
    }
  }

  /** GET requests in the log, in order. */
  private getsInLog(): ConformanceCheck[] {
    return this.checks.filter(
      (c) =>
        c.id === 'incoming-request' &&
        (c.details as { method?: unknown } | undefined)?.method === 'GET'
    );
  }

  /** The id of the last tools/call not yet answered on a GET stream. */
  private pendingFromLog(): number | string | null {
    let pending: number | string | null = null;
    for (const c of this.checks) {
      const d = (c.details ?? {}) as Record<string, unknown>;
      if (c.id === 'incoming-request' && d.jsonrpcMethod === 'tools/call') {
        pending = (d.jsonrpcId as number | string | undefined) ?? null;
      } else if (
        c.id === 'outgoing-sse-event' &&
        d.eventType === 'message' &&
        d.jsonrpcId === pending
      ) {
        pending = null;
      }
    }
    return pending;
  }

  /** The next `event-N`, past every id this cell has sent, here or elsewhere. */
  private nextEventId(): string {
    let highest = this.eventIdCounter;
    for (const c of this.checks) {
      const id = (c.details as { eventId?: unknown } | undefined)?.eventId;
      const n =
        c.id === 'outgoing-sse-event' && typeof id === 'string'
          ? Number(id.replace(/^event-/, ''))
          : NaN;
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    this.eventIdCounter = highest + 1;
    return `event-${this.eventIdCounter}`;
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
        // The retry MUST under test was introduced in 2025-11-25 (SEP-1699)
        protocolVersion: '2025-11-25',
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
    const primingEventId = this.nextEventId();
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
    // A fresh instance judging a merged log (the hosted server, where the
    // tool call and the reconnect may have reached different processes)
    // has nothing in memory: it reads the same facts from the log, timing
    // from the checks' wall-clock timestamps.
    const gets = this.getsInLog();
    const getConnectionCount = Math.max(this.getConnectionCount, gets.length);
    let closeAt = this.toolStreamCloseTime;
    let reconnectAt = this.getReconnectionTime;
    if (closeAt === null || reconnectAt === null) {
      const close = this.checks.filter((c) => c.id === 'outgoing-stream-close');
      closeAt = wallClock(close[close.length - 1]);
      reconnectAt = wallClock(gets[gets.length - 1]);
    }
    const lastEventIds = this.lastEventIds.length
      ? this.lastEventIds
      : gets
          .map(
            (c) =>
              (c.details as { headers?: Record<string, unknown> } | undefined)
                ?.headers?.['last-event-id']
          )
          .filter((v): v is string => typeof v === 'string');

    // Check 1: Client should have reconnected via GET after tool call stream close
    if (getConnectionCount < 1) {
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
          getConnectionCount,
          toolStreamCloseTime: closeAt,
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
        getConnectionCount
      }
    });

    // Check 2: Client MUST respect retry field timing
    if (closeAt !== null && reconnectAt !== null) {
      const actualDelay = reconnectAt - closeAt;
      const minExpected = this.retryValue - this.EARLY_TOLERANCE;

      // The retry MUST is a lower bound ("waiting the given number of
      // milliseconds before attempting to reconnect"), so only an early
      // reconnect fails; lateness is environment latency and is not gated.
      const tooEarly = actualDelay < minExpected;

      this.checks.push({
        id: 'client-sse-retry-timing',
        name: 'ClientRespectsRetryField',
        description:
          'Client MUST respect the retry field, waiting the given number of milliseconds before attempting to reconnect',
        status: tooEarly ? 'FAILURE' : 'SUCCESS',
        timestamp: new Date().toISOString(),
        errorMessage: tooEarly
          ? `Client reconnected too early (${actualDelay.toFixed(0)}ms instead of ${this.retryValue}ms). Client MUST respect the retry field and wait the specified time.`
          : undefined,
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
          earlyToleranceMs: this.EARLY_TOLERANCE,
          getConnectionCount
        }
      });
    } else {
      this.checks.push({
        id: 'client-sse-retry-timing',
        name: 'ClientRespectsRetryField',
        description: 'Client MUST respect the retry field timing',
        status: 'INFO',
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
          toolStreamCloseTime: closeAt,
          getReconnectionTime: reconnectAt
        }
      });
    }

    // Check 3: Client SHOULD send Last-Event-ID header on reconnection
    const hasLastEventId =
      lastEventIds.length > 0 && lastEventIds[0] !== undefined;

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
        lastEventIds,
        getConnectionCount
      },
      errorMessage: !hasLastEventId
        ? 'Client did not send Last-Event-ID header on reconnection. This is a SHOULD requirement for resumability.'
        : undefined
    });
  }
}
