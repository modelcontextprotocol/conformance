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
  private postStreamCloseTime: number | null = null;
  private getReconnectionTime: number | null = null;
  private getConnectionCount: number = 0;
  private lastEventIds: (string | undefined)[] = [];
  private retryValue: number = 2000; // 2 seconds
  private eventIdCounter: number = 0;
  private sessionId: string = `session-${Date.now()}`;
  private primingEventId: string | null = null;

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
      this.lastEventIds.push(lastEventId);

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
    res.write(`id: ${eventId}\n`);
    res.write(`retry: ${this.retryValue}\n`);
    res.write(`data: \n\n`);

    // Keep connection open for now (don't close immediately to avoid infinite reconnection loop)
    // The test will stop the server when done
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

        if (request.method === 'initialize') {
          // Respond to initialize request with SSE stream containing priming event
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'mcp-session-id': this.sessionId
          });

          // Generate priming event ID
          this.eventIdCounter++;
          this.primingEventId = `event-${this.eventIdCounter}`;

          // Send priming event with retry field
          res.write(`id: ${this.primingEventId}\n`);
          res.write(`retry: ${this.retryValue}\n`);
          res.write(`data: \n\n`);

          // Send initialize response
          const response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: {
                name: 'sse-retry-test-server',
                version: '1.0.0'
              },
              capabilities: {}
            }
          };

          res.write(`event: message\n`);
          res.write(`id: event-${++this.eventIdCounter}\n`);
          res.write(`data: ${JSON.stringify(response)}\n\n`);

          // Close connection after sending response to trigger reconnection
          // Record the time when we close the stream
          setTimeout(() => {
            this.postStreamCloseTime = performance.now();
            res.end();
          }, 100);
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

  private generateChecks(): void {
    // Check 1: Client should have reconnected via GET after POST stream close
    if (this.getConnectionCount < 1) {
      this.checks.push({
        id: 'client-sse-graceful-reconnect',
        name: 'ClientGracefulReconnect',
        description:
          'Client reconnects via GET after POST SSE stream is closed gracefully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Client did not attempt GET reconnection after POST stream closure. Client should treat graceful stream close as reconnectable.`,
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          getConnectionCount: this.getConnectionCount,
          postStreamCloseTime: this.postStreamCloseTime,
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
        'Client reconnects via GET after POST SSE stream is closed gracefully',
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
      this.postStreamCloseTime !== null &&
      this.getReconnectionTime !== null
    ) {
      const actualDelay = this.getReconnectionTime - this.postStreamCloseTime;
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
          'Could not measure timing - POST stream close time or GET reconnection time not recorded',
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          postStreamCloseTime: this.postStreamCloseTime,
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
        primingEventId: this.primingEventId,
        getConnectionCount: this.getConnectionCount
      },
      errorMessage: !hasLastEventId
        ? 'Client did not send Last-Event-ID header on reconnection. This is a SHOULD requirement for resumability.'
        : undefined
    });
  }
}
