import {
  withRequiredDraftResultFields,
  type ScenarioContext
} from '../../mock-server';
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
  Scenario,
  ScenarioUrls,
  ConformanceCheck,
  ScenarioSource,
  DRAFT_PROTOCOL_VERSION
} from '../../types.js';

export abstract class BaseHttpScenario implements Scenario {
  abstract name: string;
  abstract description: string;
  readonly source: ScenarioSource = { introducedIn: DRAFT_PROTOCOL_VERSION };
  allowClientError?: boolean;

  protected server: http.Server | null = null;
  protected checks: ConformanceCheck[] = [];
  protected port: number = 0;
  protected sessionId: string = `session-${Date.now()}`;

  async start(_ctx: ScenarioContext): Promise<ScenarioUrls> {
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
        if (request.method === 'server/discover') {
          this.sendDiscover(res, request);
          return;
        }
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

  /**
   * Capabilities advertised to a 2026-07-28 client via `server/discover` (and
   * defaulted in the legacy `initialize` reply). Subclasses override to match
   * the methods they actually serve.
   */
  protected discoverCapabilities(): object {
    return { tools: {} };
  }

  protected sendDiscover(res: http.ServerResponse, request: any): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: withRequiredDraftResultFields('server/discover', {
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities: this.discoverCapabilities(),
        serverInfo: { name: this.name + '-server', version: '1.0.0' }
      })
    });
  }

  protected sendInitialize(
    res: http.ServerResponse,
    request: any,
    capabilities: object = this.discoverCapabilities()
  ): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
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
      // Method-aware so cacheable methods that fall through to the generic
      // reply still carry the ttlMs/cacheScope the draft revision requires.
      result: withRequiredDraftResultFields(request.method, {})
    });
  }
}
