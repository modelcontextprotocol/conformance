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
      const metaVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
      const headerVersion = req.headers['mcp-protocol-version'];

      // "Every POST request to the MCP endpoint MUST include an
      //  MCP-Protocol-Version header." — unconditional, so this fires for
      // server/discover too.
      this.checks.push({
        id: 'sep-2575-http-client-sends-version-header',
        name: 'ClientSendsVersionHeader',
        description:
          'Client sends MCP-Protocol-Version header on every POST',
        status: headerVersion !== undefined ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#protocol-version-header'
          }
        ],
        details: { method: request.method, headerVersion }
      });

      // "Every client request MUST include the following
      //  io.modelcontextprotocol/* fields in _meta: protocolVersion,
      //  clientInfo, clientCapabilities."
      const hasClientInfo = meta?.['io.modelcontextprotocol/clientInfo'];
      const hasCapabilities =
        meta?.['io.modelcontextprotocol/clientCapabilities'];
      const metaIsValid = metaVersion && hasClientInfo && hasCapabilities;

      this.checks.push({
        id: 'sep-2575-client-populates-meta',
        name: 'ClientPopulatesMeta',
        description:
          'Client populates _meta on every request with all three required fields',
        status: metaIsValid ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/index#meta'
          }
        ],
        details: { method: request.method, meta }
      });

      // "The header value MUST match the io.modelcontextprotocol/protocolVersion
      //  field carried in the request body's _meta." Only meaningful when both
      // are present; absence is already covered by the two checks above.
      if (headerVersion !== undefined && metaVersion !== undefined) {
        this.checks.push({
          id: 'sep-2575-http-version-header-matches-meta',
          name: 'ClientVersionHeaderMatchesMeta',
          description:
            'MCP-Protocol-Version header matches _meta.protocolVersion',
          status: headerVersion === metaVersion ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-2575',
              url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#protocol-version-header'
            }
          ],
          details: { headerVersion, metaVersion }
        });
      }

      // server/discover is optional for clients (spec: "Clients MAY call it"),
      // so no check is emitted; we still respond so a client that does call it
      // proceeds normally and exercises the per-request _meta/header checks above.
      if (request.method === 'server/discover') {
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

      // Return generic response to unblock client
      let result: object = {};
      if (request.method === 'tools/list') {
        result = { tools: [] };
      } else if (request.method === 'tools/call') {
        result = { content: [] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  }
}
