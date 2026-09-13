import http from 'http';
import {
  HandlerScenario,
  RequestListener,
  ConformanceCheck,
  LATEST_SPEC_VERSION,
  NEGOTIABLE_PROTOCOL_VERSIONS,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import { clientChecks } from '../../checks/index';

export class InitializeScenario extends HandlerScenario {
  name = 'initialize';
  readonly source = {
    introducedIn: '2025-06-18',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description = 'Tests MCP client initialization handshake';

  private checks: ConformanceCheck[] = [];

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    return (req, res) => this.handleRequest(req, res);
  }

  /** Plumbing only: connect (implicit) and make one ordinary request. */
  readonly steps = [{ op: 'tools/list' }] as const;

  getChecks(): ConformanceCheck[] {
    return this.checks;
  }

  private handleRequest(
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
          this.handleInitialize(request, res);
        } else if (request.method === 'tools/list') {
          this.handleToolsList(request, res);
        } else if (request.method === 'notifications/initialized') {
          // Per MCP spec 2025-11-25 section 2.1 (Sending Messages to the Server),
          // point 4: "If the input is a JSON-RPC response or notification ...
          // the server MUST return HTTP status code 202 Accepted with no body."
          res.writeHead(202);
          res.end();
        } else if (request.method === 'ping' || request.id === undefined) {
          // Empty result for ping; notifications and responses get none.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {}
            })
          );
        } else {
          // A method this dated server does not have — notably the
          // 2026-07-28 `server/discover` probe of a dual-era client, which
          // must be turned away so the client falls back to `initialize`
          // rather than read an empty result as a discovery.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: `Method not found: ${request.method}`
              }
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
              message: `Parse error ${error}`
            }
          })
        );
      }
    });
  }

  private handleInitialize(request: any, res: http.ServerResponse): void {
    const initializeRequest = request.params;

    const check =
      clientChecks.createClientInitializationCheck(initializeRequest);
    this.checks.push(check);

    const serverInfo = {
      name: 'test-server',
      version: '1.0.0'
    };

    this.checks.push(clientChecks.createServerInfoCheck(serverInfo));

    // Echo back client's version if valid, otherwise use latest
    const clientVersion = initializeRequest?.protocolVersion;
    const responseVersion = NEGOTIABLE_PROTOCOL_VERSIONS.includes(clientVersion)
      ? clientVersion
      : LATEST_SPEC_VERSION;

    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: responseVersion,
        serverInfo,
        capabilities: {}
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private handleToolsList(request: any, res: http.ServerResponse): void {
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: []
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }
}
