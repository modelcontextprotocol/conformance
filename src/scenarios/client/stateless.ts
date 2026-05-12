import http from 'http';
import {
  Scenario,
  ScenarioUrls,
  ConformanceCheck,
  SpecVersion,
  DRAFT_PROTOCOL_VERSION
} from '../../types';

export class StatelessClientScenario implements Scenario {
  name = 'stateless-client';
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = 'Tests stateless MCP client behavior (SEP-2575)';

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];

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
        this.server.close(() => { resolve(); });
      } else {
        resolve();
      }
    });
  }

  getChecks(): ConformanceCheck[] {
    return this.checks;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      const request = JSON.parse(body);

      // TEST 1: Verify client can call server/discover
      if (request.method === 'server/discover') {
        this.checks.push({
          id: 'client-calls-discover',
          name: 'ClientCallsDiscover',
          description: 'Client is able to successfully call server/discover',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [{ id: 'SEP-2575', url: '' }]
        });
        
        // Respond with valid discovery payload to keep client happy
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { 
            supportedVersions: ['2026-06-18'], 
            capabilities: {}, 
            serverInfo: { name: 'test', version: '1.0' } 
          }
        }));
        return;
      }

      // TEST 2: Verify inline _meta on every request
      const meta = request.params?._meta;
      const hasProtocolVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
      const hasClientInfo = meta?.['io.modelcontextprotocol/clientInfo'];
      const hasCapabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];

      const metaIsValid = hasProtocolVersion && hasClientInfo && hasCapabilities;

      this.checks.push({
        id: 'client-populates-meta',
        name: 'ClientPopulatesMeta',
        description: 'Client populates _meta on every request with all three required fields',
        status: metaIsValid ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'SEP-2575', url: '' }],
        details: { meta }
      });

      // Return generic response to unblock client
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
    });
  }
}
