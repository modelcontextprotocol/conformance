import http from 'http';
import {
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  Scenario,
  ScenarioUrls
} from '../../types';
import type { ScenarioContext } from '../../mock-server';
import {
  isDraftModernProbe,
  isRecord,
  LEGACY_PROTOCOL_VERSION,
  parseJsonRecord,
  readLimitedRequestBody
} from '../../version-compat';
import { HEADER_MISMATCH } from '../../spec-types/draft';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Version-Compatibility',
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility'
  }
];

const CHECKS = [
  {
    id: 'version-backcompat-client-modern-probe',
    name: 'ClientModernProbe',
    description:
      'Dual-era client sends a valid modern request before selecting legacy behavior'
  },
  {
    id: 'version-backcompat-client-legacy-initialize',
    name: 'ClientLegacyInitializeFallback',
    description:
      'Dual-era client falls back to a legacy initialize after an unrecognized HTTP 400 response'
  },
  {
    id: 'version-backcompat-client-legacy-request',
    name: 'ClientLegacyRequestAfterFallback',
    description:
      'Dual-era client completes a legacy request after the initialize fallback'
  }
] as const;

type CheckId = (typeof CHECKS)[number]['id'];

export class VersionBackcompatScenario implements Scenario {
  name = 'version-backcompat';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Tests dual-era client fallback from modern Streamable HTTP to
legacy initialization-based MCP.

The scenario returns HTTP 400 with a generic legacy JSON-RPC error to the
client's first valid modern request. A conformant dual-era client identifies
the server as legacy, performs an initialization-era handshake, and completes
a legacy request.`;

  private server: http.Server | null = null;
  private checks: ConformanceCheck[] = [];
  private modernProbeObserved = false;
  private initializeObserved = false;

  async start(_ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.modernProbeObserved = false;
    this.initializeObserved = false;
    this.checks = CHECKS.map((definition) => ({
      ...definition,
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: 'Client did not exercise this compatibility step',
      specReferences: SPEC_REFERENCES
    }));

    return new Promise((resolve, reject) => {
      this.server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      this.server.requestTimeout = 5_000;
      this.server.headersTimeout = 5_000;
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to determine compatibility server port'));
          return;
        }
        resolve({ serverUrl: `http://127.0.0.1:${address.port}/mcp` });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  getChecks(): ConformanceCheck[] {
    return this.checks;
  }

  private pass(id: CheckId, details?: Record<string, unknown>): void {
    const check = this.checks.find((candidate) => candidate.id === id);
    if (!check) return;
    check.status = 'SUCCESS';
    check.errorMessage = undefined;
    check.details = details;
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    let rawBody: string;
    try {
      rawBody = await readLimitedRequestBody(request);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(error instanceof RangeError ? 413 : 400).end();
      }
      return;
    }

    const body = parseJsonRecord(rawBody);
    if (!body) {
      response.writeHead(400).end();
      return;
    }

    const params = isRecord(body.params) ? body.params : undefined;
    const meta = params && isRecord(params._meta) ? params._meta : undefined;
    const declaresDraft =
      meta?.['io.modelcontextprotocol/protocolVersion'] ===
      DRAFT_PROTOCOL_VERSION;

    if (declaresDraft) {
      if (isDraftModernProbe(request, body)) {
        this.modernProbeObserved = true;
        this.pass('version-backcompat-client-modern-probe', {
          method: body.method,
          protocolVersion: DRAFT_PROTOCOL_VERSION,
          mcpMethod: request.headers['mcp-method']
        });
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32600, message: 'Invalid Request' }
          })
        );
      } else {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: {
              code: HEADER_MISMATCH,
              message: 'Missing or mismatched modern request headers'
            }
          })
        );
      }
      return;
    }

    if (body.method === 'initialize') {
      const protocolVersion = params?.protocolVersion;
      this.initializeObserved =
        this.modernProbeObserved && protocolVersion === LEGACY_PROTOCOL_VERSION;
      if (this.initializeObserved) {
        this.pass('version-backcompat-client-legacy-initialize', {
          protocolVersion
        });
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'legacy-test-server', version: '1.0.0' }
          }
        })
      );
      return;
    }

    if (body.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }

    if (body.method === 'tools/list') {
      if (this.modernProbeObserved && this.initializeObserved) {
        this.pass('version-backcompat-client-legacy-request', {
          method: body.method
        });
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [] }
        })
      );
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
  }
}
