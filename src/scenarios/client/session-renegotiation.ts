/**
 * Session renegotiation on HTTP 404 conformance scenario for MCP clients.
 *
 * Streamable HTTP session management (introduced in 2025-03-26, carried through
 * 2025-11-25) lets a server assign a session via the `MCP-Session-Id` header at
 * initialization time. The server MAY terminate that session at any time, after
 * which it MUST respond to requests carrying that session ID with HTTP 404.
 *
 * The requirement this scenario tests is the client side of that exchange:
 *
 *   "When a client receives HTTP 404 in response to a request containing an
 *    `MCP-Session-Id`, it MUST start a new session by sending a new
 *    InitializeRequest without a session ID attached."
 *
 * In practice many clients "brick" the connection for the rest of a trajectory
 * when this happens (a remote server is redeployed, in-memory sessions are lost
 * on restart, etc.) instead of renegotiating. This scenario reproduces that
 * mid-trajectory session loss with a mock server that:
 *
 *   1. Accepts the first `initialize` and assigns session A.
 *   2. Returns HTTP 404 to the next session-bearing request (session A is
 *      "terminated" mid-trajectory).
 *   3. Expects the client to send a fresh `initialize` with NO session ID,
 *      assigns session B, and continues operating normally afterwards.
 *
 * Checks emitted (MUST -> FAILURE per the spec keyword):
 *   - client-session-renegotiate-on-404: client sent a new initialize with no
 *     session ID after receiving the 404.
 *   - client-session-continues-after-renegotiation: client resumed normal
 *     operation under the new session (a post-reinitialize request succeeded).
 *
 * See issue #76. This is strictly the CLIENT side; the server-side 404 behavior
 * is tracked separately under issue #79.
 */

import http from 'http';
import { Scenario, ScenarioUrls, ConformanceCheck } from '../../types.js';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Transports-Session-Management',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management'
  }
];

const SESSION_ID_HEADER = 'mcp-session-id';

interface ObservedRequest {
  method: string | undefined;
  hadSessionId: boolean;
  sessionId: string | undefined;
}

export class SessionRenegotiation404Scenario implements Scenario {
  name = 'session-renegotiation-404';
  // Streamable HTTP session management (and therefore the 404 renegotiation
  // requirement) was introduced in 2025-03-26 and carried through 2025-11-25.
  // It is NOT part of the draft spec, which removed `MCP-Session-Id`.
  readonly source = { introducedIn: '2025-03-26' } as const;
  description =
    'Tests that a client renegotiates its session when the server returns HTTP 404 to a request carrying an MCP-Session-Id: the client MUST send a new InitializeRequest without a session ID and continue operating (mid-trajectory session loss).';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private port: number = 0;

  // Session bookkeeping.
  private readonly firstSessionId = `session-A-${Date.now()}`;
  private readonly secondSessionId = `session-B-${Date.now()}`;

  // Trajectory state, advanced as the client drives the exchange.
  private firstInitializeSeen = false;
  private firstSessionTerminated = false; // we have served the 404 at least once
  private reinitializeWithoutSession = false; // the MUST behavior
  private reinitializeWithStaleSession = false; // a spec violation, tracked for diagnostics
  private postRenegotiationRequestSeen = false; // continued operating
  private initializeCount = 0;

  // Full request log for diagnostics in the emitted checks.
  private observed: ObservedRequest[] = [];

  async start(): Promise<ScenarioUrls> {
    // Reset trajectory state so the scenario instance can be reused across
    // runs (the registry holds a single instance per scenario name).
    this.checks = [];
    this.firstInitializeSeen = false;
    this.firstSessionTerminated = false;
    this.reinitializeWithoutSession = false;
    this.reinitializeWithStaleSession = false;
    this.postRenegotiationRequestSeen = false;
    this.initializeCount = 0;
    this.observed = [];

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(0, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve({ serverUrl: `http://localhost:${this.port}` });
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
    // Rebuilt from scratch on every call so getChecks() is idempotent — the
    // runner may call it more than once and we must not accumulate duplicates.
    this.checks = [];
    this.generateChecks();
    return this.checks;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // A standalone GET stream is optional and not the subject of this test.
    // Accept and immediately end it so a client that opens one is not blocked.
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let request: any;
      try {
        request = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: `Parse error: ${error}` }
          })
        );
        return;
      }
      this.handlePost(req, res, request);
    });
  }

  private handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    const sessionIdHeader = req.headers[SESSION_ID_HEADER];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    const hadSessionId = typeof sessionId === 'string' && sessionId.length > 0;

    this.observed.push({
      method: request?.method,
      hadSessionId,
      sessionId
    });

    if (request?.method === 'initialize') {
      this.handleInitialize(res, request, hadSessionId);
      return;
    }

    // Notifications (e.g. notifications/initialized) carry no id; ack them.
    if (request?.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    // Non-initialize, id-bearing requests (tools/list, ping, ...).
    if (!this.firstSessionTerminated) {
      // First session-bearing request after init: terminate the session by
      // responding 404. This is the mid-trajectory session-loss event.
      this.firstSessionTerminated = true;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32001, message: 'Session not found' }
        })
      );
      return;
    }

    // Any further session-bearing request must be carrying the renegotiated
    // session (B). If the client got here it kept operating after the 404.
    this.postRenegotiationRequestSeen = true;
    this.handleGenericResult(res, request);
  }

  private handleInitialize(
    res: http.ServerResponse,
    request: any,
    hadSessionId: boolean
  ): void {
    this.initializeCount++;

    if (!this.firstInitializeSeen) {
      // First handshake: assign session A.
      this.firstInitializeSeen = true;
      this.sendInitializeResult(res, request, this.firstSessionId);
      return;
    }

    // This is a re-initialize. It is only correct if it happens AFTER the 404
    // and carries NO session ID. A re-initialize that still attaches the stale
    // session ID is the spec violation we want to surface.
    if (this.firstSessionTerminated) {
      if (hadSessionId) {
        this.reinitializeWithStaleSession = true;
      } else {
        this.reinitializeWithoutSession = true;
      }
    }

    // Assign session B regardless, so a client that did the right thing can
    // continue operating and we can validate the follow-through.
    this.sendInitializeResult(res, request, this.secondSessionId);
  }

  private sendInitializeResult(
    res: http.ServerResponse,
    request: any,
    sessionId: string
  ): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-11-25',
          serverInfo: {
            name: 'session-renegotiation-404-server',
            version: '1.0.0'
          },
          capabilities: { tools: {} }
        }
      })
    );
  }

  private handleGenericResult(res: http.ServerResponse, request: any): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.secondSessionId
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: request?.method === 'tools/list' ? { tools: [] } : {}
      })
    );
  }

  private generateChecks(): void {
    const timestamp = new Date().toISOString();
    const details = {
      initializeCount: this.initializeCount,
      firstSessionTerminated: this.firstSessionTerminated,
      reinitializeWithoutSession: this.reinitializeWithoutSession,
      reinitializeWithStaleSession: this.reinitializeWithStaleSession,
      postRenegotiationRequestSeen: this.postRenegotiationRequestSeen,
      observedRequests: this.observed
    };

    // Check 1: client MUST start a new session (fresh initialize, no session
    // ID) after receiving the 404.
    if (this.reinitializeWithoutSession) {
      this.checks.push({
        id: 'client-session-renegotiate-on-404',
        name: 'ClientRenegotiatesSessionOn404',
        description:
          'Client starts a new session by sending a new InitializeRequest without a session ID after receiving HTTP 404 for a request carrying an MCP-Session-Id',
        status: 'SUCCESS',
        timestamp,
        specReferences: SPEC_REFERENCES,
        details
      });
    } else {
      let errorMessage: string;
      if (!this.firstSessionTerminated) {
        errorMessage =
          'Client never sent a session-bearing request after initialize, so the 404 renegotiation requirement could not be exercised. The client must initialize and then make at least one further request.';
      } else if (this.reinitializeWithStaleSession) {
        errorMessage =
          'Client re-initialized after the 404 but still attached the terminated session ID. The new InitializeRequest MUST be sent without a session ID attached.';
      } else {
        errorMessage =
          'Client did not send a new InitializeRequest after receiving HTTP 404 for a session-bearing request. Per the spec it MUST start a new session by re-initializing without a session ID, rather than failing permanently (mid-trajectory session loss).';
      }
      this.checks.push({
        id: 'client-session-renegotiate-on-404',
        name: 'ClientRenegotiatesSessionOn404',
        description:
          'Client starts a new session by sending a new InitializeRequest without a session ID after receiving HTTP 404 for a request carrying an MCP-Session-Id',
        status: 'FAILURE',
        timestamp,
        errorMessage,
        specReferences: SPEC_REFERENCES,
        details
      });
    }

    // Check 2: after renegotiating, the client MUST continue operating (issue
    // a request under the new session). This is the "doesn't brick the
    // trajectory" follow-through. Only meaningful once renegotiation happened;
    // if the client never renegotiated, Check 1 already reports the failure, so
    // we SKIP this one rather than double-counting.
    if (!this.reinitializeWithoutSession) {
      this.checks.push({
        id: 'client-session-continues-after-renegotiation',
        name: 'ClientContinuesAfterRenegotiation',
        description:
          'After renegotiating the session, the client continues operating by issuing a further request under the new session',
        status: 'SKIPPED',
        timestamp,
        errorMessage:
          'Client did not renegotiate the session, so post-renegotiation operation could not be evaluated (see client-session-renegotiate-on-404).',
        specReferences: SPEC_REFERENCES,
        details
      });
      return;
    }

    this.checks.push({
      id: 'client-session-continues-after-renegotiation',
      name: 'ClientContinuesAfterRenegotiation',
      description:
        'After renegotiating the session, the client continues operating by issuing a further request under the new session',
      status: this.postRenegotiationRequestSeen ? 'SUCCESS' : 'FAILURE',
      timestamp,
      errorMessage: this.postRenegotiationRequestSeen
        ? undefined
        : 'Client re-initialized after the 404 but never issued a further request under the new session. A client MUST continue operating after renegotiation rather than bricking the trajectory.',
      specReferences: SPEC_REFERENCES,
      details
    });
  }
}
