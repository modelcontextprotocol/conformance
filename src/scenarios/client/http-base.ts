/**
 * Shared HTTP test-server scaffold for client-under-test SEP-2243 scenarios.
 *
 * A scenario that needs to act as a Streamable-HTTP MCP server, inspect
 * incoming client requests, and emit ConformanceChecks should extend this
 * class and implement handlePost() + getChecks(). start()/stop() and the
 * GET/DELETE/body-parse boilerplate are handled here.
 */

import http from 'http';
import {
  HandlerScenario,
  RequestListener,
  ConformanceCheck,
  ScenarioSource,
  DRAFT_PROTOCOL_VERSION
} from '../../types.js';

export abstract class BaseHttpScenario extends HandlerScenario {
  abstract name: string;
  abstract description: string;
  readonly source: ScenarioSource = { introducedIn: DRAFT_PROTOCOL_VERSION };

  protected checks: ConformanceCheck[] = [];
  protected sessionId: string = `session-${Date.now()}`;

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    this.sessionId = `session-${Date.now()}`;
    return (req, res) => this.handleRequest(req, res);
  }

  abstract getChecks(): ConformanceCheck[];

  protected handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
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
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Decode the stream as UTF-8 so multi-byte characters that straddle a
    // chunk boundary aren't corrupted by per-chunk Buffer.toString().
    req.setEncoding('utf8');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        this.handlePost(req, res, request);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: `Parse error: ${error}` }
          })
        );
      }
    });
  }

  protected abstract handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void;

  protected sendJson(res: http.ServerResponse, body: object): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'mcp-session-id': this.sessionId
    });
    res.end(JSON.stringify(body));
  }

  protected sendInitialize(
    res: http.ServerResponse,
    request: any,
    capabilities: object = { tools: {} }
  ): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: DRAFT_PROTOCOL_VERSION,
        serverInfo: { name: this.name + '-server', version: '1.0.0' },
        capabilities
      }
    });
  }

  protected sendNotificationAck(res: http.ServerResponse): void {
    res.writeHead(202);
    res.end();
  }

  protected sendGenericResult(res: http.ServerResponse, request: any): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {}
    });
  }
}
