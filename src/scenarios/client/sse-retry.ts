/**
 * SSE Retry conformance test scenarios for MCP clients (SEP-1699)
 *
 * Tests that clients properly respect the SSE retry field by:
 * - Waiting the specified milliseconds before reconnecting
 * - Sending Last-Event-ID header on reconnection
 */

import http from 'http';
import { Scenario, ScenarioUrls, ConformanceCheck } from '../../types.js';

export class SSERetryScenario implements Scenario {
  name = 'sse-retry';
  description = 'Tests that client respects SSE retry field timing (SEP-1699)';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private port: number = 0;

  // Timing tracking
  private connectionTimestamps: number[] = [];
  private lastEventIds: (string | undefined)[] = [];
  private retryValue: number = 2000; // 2 seconds
  private eventIdCounter: number = 0;

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
      // Track timing and Last-Event-ID only for GET requests
      // since retry field only applies to SSE stream reconnections
      const timestamp = performance.now();
      this.connectionTimestamps.push(timestamp);

      const lastEventId = req.headers['last-event-id'] as string | undefined;
      this.lastEventIds.push(lastEventId);

      // Handle SSE stream request
      this.handleSSEStream(req, res);
    } else if (req.method === 'POST') {
      // Handle JSON-RPC requests (for initialization)
      this.handleJSONRPC(req, res);
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  }

  private handleSSEStream(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    // Generate event ID
    this.eventIdCounter++;
    const eventId = `event-${this.eventIdCounter}`;

    // Send priming event with ID and empty data
    res.write(`id: ${eventId}\n`);
    res.write(`retry: ${this.retryValue}\n`);
    res.write(`data: \n\n`);

    // Close connection after a short delay to trigger client reconnection
    setTimeout(() => {
      res.end();
    }, 100);
  }

  private handleJSONRPC(
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
          // Respond to initialize request with SSE stream
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });

          // Generate event ID
          this.eventIdCounter++;
          const eventId = `event-${this.eventIdCounter}`;

          // Send priming event
          res.write(`id: ${eventId}\n`);
          res.write(`retry: ${this.retryValue}\n`);
          res.write(`data: \n\n`);

          // Send initialize response
          const response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2025-06-18',
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
          setTimeout(() => {
            res.end();
          }, 100);
        } else if (request.id === undefined) {
          // Notifications (no id) - return 202 Accepted
          // This triggers the client to start a GET SSE stream
          res.writeHead(202);
          res.end();
        } else {
          // For other requests, send a simple JSON response
          res.writeHead(200, { 'Content-Type': 'application/json' });
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
    // Check 1: Client should have reconnected
    if (this.connectionTimestamps.length < 2) {
      this.checks.push({
        id: 'client-sse-retry-reconnect',
        name: 'ClientReconnects',
        description: 'Client reconnects after server disconnect',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Expected at least 2 connections, got ${this.connectionTimestamps.length}. Client may not have attempted to reconnect.`,
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          connectionCount: this.connectionTimestamps.length,
          retryValue: this.retryValue
        }
      });
      return;
    }

    // Check 2: Client MUST respect retry field timing
    const actualDelay =
      this.connectionTimestamps[1] - this.connectionTimestamps[0];
    const minExpected = this.retryValue - this.EARLY_TOLERANCE;
    const maxExpected = this.retryValue + this.LATE_TOLERANCE;

    const tooEarly = actualDelay < minExpected;
    const slightlyLate = actualDelay > maxExpected;
    const veryLate = actualDelay > this.retryValue * this.VERY_LATE_MULTIPLIER;
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
        connectionCount: this.connectionTimestamps.length
      }
    });

    // Check 3: Client SHOULD send Last-Event-ID header on reconnection
    const hasLastEventId =
      this.lastEventIds.length > 1 && this.lastEventIds[1] !== undefined;

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
        connectionCount: this.connectionTimestamps.length
      },
      errorMessage: !hasLastEventId
        ? 'Client did not send Last-Event-ID header on reconnection. This is a SHOULD requirement for resumability.'
        : undefined
    });
  }
}
