import http from 'http';
import {
  Scenario,
  ScenarioUrls,
  ConformanceCheck,
  SpecVersion,
  DRAFT_PROTOCOL_VERSION
} from '../../types';

export class StatelessScenario implements Scenario {
  name = 'stateless';
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = 'Tests stateless MCP client behavior (SEP-2575)';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private negotiatedVersion: string | null = null;

  async start(): Promise<ScenarioUrls> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.on('error', reject);
      this.server.listen(0, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          resolve({ serverUrl: `http://localhost:${address.port}` });
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
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
      const request = JSON.parse(body);

      // Extract version and headers
      const meta = request.params?._meta;
      const currentVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
      const headerVersion = req.headers['mcp-protocol-version'];

      // [HTTP] Sends MCP-Protocol-Version header on every request, equal to _meta.protocolVersion
      if (currentVersion) {
        this.checks.push({
          id: 'client-sends-version-header',
          name: 'ClientSendsVersionHeader',
          description:
            'Client sends MCP-Protocol-Version header equal to _meta.protocolVersion',
          status: headerVersion === currentVersion ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [{ id: 'SEP-2575', url: '' }]
        });
      }

      // Sends a consistent protocolVersion once chosen
      if (currentVersion) {
        if (!this.negotiatedVersion) {
          this.negotiatedVersion = currentVersion;
        } else {
          this.checks.push({
            id: 'client-consistent-version',
            name: 'ClientConsistentVersion',
            description:
              'Client sends a consistent protocolVersion once chosen',
            status:
              currentVersion === this.negotiatedVersion ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            specReferences: [{ id: 'SEP-2575', url: '' }]
          });
        }
      }

      // Verify client can call server/discover
      if (request.method === 'server/discover') {
        this.checks.push({
          id: 'client-calls-discover',
          name: 'ClientCallsDiscover',
          description: 'Client is able to successfully call server/discover',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [{ id: 'SEP-2575', url: '' }]
        });

        // Respond with valid discovery payload
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              supportedVersions: [DRAFT_PROTOCOL_VERSION],
              capabilities: {},
              serverInfo: { name: 'test', version: '1.0' }
            }
          })
        );
        return;
      }

      // [STDIO] Cancels by sending notifications/cancelled with the request id
      if (request.method === 'notifications/cancelled') {
        this.checks.push({
          id: 'client-cancels-by-notification',
          name: 'ClientCancelsByNotification',
          description:
            'Client cancels by sending notifications/cancelled with the request id',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [{ id: 'SEP-2575', url: '' }]
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
        return;
      }

      // Verify inline _meta on every request
      const hasProtocolVersion =
        meta?.['io.modelcontextprotocol/protocolVersion'];
      const hasClientInfo = meta?.['io.modelcontextprotocol/clientInfo'];
      const hasCapabilities =
        meta?.['io.modelcontextprotocol/clientCapabilities'];

      const metaIsValid =
        hasProtocolVersion && hasClientInfo && hasCapabilities;

      this.checks.push({
        id: 'client-populates-meta',
        name: 'ClientPopulatesMeta',
        description:
          'Client populates _meta on every request with all three required fields',
        status: metaIsValid ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'SEP-2575', url: '' }],
        details: { meta }
      });

      // Handle long running task for cancellation testing
      if (
        request.method === 'tools/call' &&
        request.params?.name === 'long_running_task'
      ) {
        // Do not respond immediately, wait for client to abort (req close) or send cancel notification
        req.on('close', () => {
          if (!res.writableEnded) {
            this.checks.push({
              id: 'client-cancels-by-closing-stream',
              name: 'ClientCancelsByClosingStream',
              description: 'Client cancels by closing the stream (request)',
              status: 'SUCCESS',
              timestamp: new Date().toISOString(),
              specReferences: [{ id: 'SEP-2575', url: '' }]
            });
          }
        });
        return; // Keep request open
      }

      // Return generic response to unblock client
      let result: any = {};
      if (request.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'long_running_task',
              description: 'A mock long running task for cancellation',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        };
      } else if (request.method === 'tools/call') {
        result = { content: [] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  }
}
