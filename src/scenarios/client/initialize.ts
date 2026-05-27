import http from 'http';
import {
  HandlerScenario,
  RequestListener,
  ConformanceCheck,
  LATEST_SPEC_VERSION,
  NEGOTIABLE_PROTOCOL_VERSIONS
} from '../../types';
import { clientChecks } from '../../checks/index';

export class InitializeScenario extends HandlerScenario {
  name = 'initialize';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = 'Tests MCP client initialization handshake';

  private checks: ConformanceCheck[] = [];

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    return (req, res) => this.handleRequest(req, res);
  }

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
        } else {
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
