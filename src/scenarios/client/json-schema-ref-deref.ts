import type { ScenarioContext } from '../../mock-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Scenario, ConformanceCheck } from '../../types';
import express, { Request, Response } from 'express';
import { ScenarioUrls, DRAFT_PROTOCOL_VERSION } from '../../types';

/**
 * Scenario: JSON Schema network $ref dereferencing (SEP-2106)
 *
 * SEP-2106 permits the full JSON Schema 2020-12 vocabulary in tool schemas,
 * including `$ref`. A `$ref` that resolves to a network URI is an SSRF /
 * fetch-DoS vector: a malicious tool definition could point at internal
 * infrastructure and have the *client* fetch it during schema processing.
 *
 * Per SEP-2106, implementations MUST NOT automatically dereference `$ref`
 * values that resolve to a network URI (anything that is not a same-document
 * JSON Pointer such as `#/$defs/Foo` or an internal `$anchor`).
 *
 * This scenario advertises a tool whose inputSchema contains both a
 * same-document `$ref` and a `$ref` to a canary URL hosted by the scenario
 * itself. If the client fetches the canary URL at any point before the
 * scenario stops, the check fails.
 */

const TOOL_NAME = 'lookup_user';
const CANARY_PATH = '/canary/profile-schema.json';
const CHECK_ID = 'sep-2106-no-network-ref-deref';

const SPEC_REFERENCES = [
  {
    id: 'SEP-2106',
    url: 'https://modelcontextprotocol.io/seps/2106-json-schema-2020-12#security-implications'
  }
];

function createMcpServer(canaryUrl: string, onToolsListed: () => void): Server {
  const server = new Server(
    { name: 'json-schema-ref-deref-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    onToolsListed();
    return {
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      tools: [
        {
          name: TOOL_NAME,
          description: 'Look up a user profile by id',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            $defs: {
              userId: { type: 'string', pattern: '^[a-z0-9-]+$' }
            },
            properties: {
              // Same-document $ref: safe, expected to be resolvable locally.
              id: { $ref: '#/$defs/userId' },
              // Network $ref: the canary. Implementations MUST NOT fetch this
              // automatically while processing the schema.
              profile: { $ref: canaryUrl }
            },
            required: ['id']
          }
        }
      ]
    };
  });

  return server;
}

export class JsonSchemaRefDerefScenario implements Scenario {
  name = 'json-schema-ref-no-deref';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Tests that a client does not automatically dereference a network-URI \`$ref\` in a tool's inputSchema (SEP-2106).

The scenario advertises a tool whose inputSchema contains a \`$ref\` pointing at a canary URL. The client should list tools (and may otherwise process the schema), but must not fetch the canary URL. Same-document refs (\`#/$defs/...\`) remain safe to resolve.`;

  private app: express.Application | null = null;
  private httpServer: ReturnType<express.Application['listen']> | null = null;
  private canaryRequests: Array<{ method: string; userAgent?: string }> = [];
  private toolsListed = false;

  async start(_ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.canaryRequests = [];
    this.toolsListed = false;

    const app = express();
    app.use(express.json());

    // Canary endpoint: any request here means the client dereferenced the
    // network $ref. Return a valid schema so a dereferencing client gets a
    // realistic response rather than an error it might silently swallow.
    app.all(CANARY_PATH, (req: Request, res: Response) => {
      this.canaryRequests.push({
        method: req.method,
        userAgent: req.headers['user-agent']
      });
      res.json({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { displayName: { type: 'string' } }
      });
    });

    app.post('/mcp', async (req: Request, res: Response) => {
      // The bundled SDK server below predates the 2026-07-28 lifecycle and
      // does not implement server/discover; answer it directly so a client
      // that negotiates first can proceed to tools/list.
      if (
        (req.body as Record<string, unknown> | undefined)?.method ===
        'server/discover'
      ) {
        return res.json({
          jsonrpc: '2.0',
          id: (req.body as Record<string, unknown>).id ?? null,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            supportedVersions: [DRAFT_PROTOCOL_VERSION],
            capabilities: { tools: {} },
            serverInfo: {
              name: 'json-schema-ref-deref-server',
              version: '1.0.0'
            }
          }
        });
      }
      try {
        // Stateless: fresh server and transport per request
        const server = createMcpServer(this.canaryUrl(), () => {
          this.toolsListed = true;
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
            },
            id: null
          });
        }
      }
    });

    this.app = app;
    this.httpServer = app.listen(0);
    return { serverUrl: `${this.baseUrl()}/mcp` };
  }

  private baseUrl(): string {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Scenario server is not listening');
    }
    return `http://localhost:${address.port}`;
  }

  private canaryUrl(): string {
    return `${this.baseUrl()}${CANARY_PATH}`;
  }

  async stop() {
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer!.close(resolve));
      this.httpServer = null;
    }
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    // Built fresh on every call so getChecks() is idempotent — the runner may
    // call it more than once and we must not accumulate duplicates.
    const timestamp = new Date().toISOString();
    const fetched = this.canaryRequests.length > 0;

    if (!this.toolsListed) {
      return [
        {
          id: CHECK_ID,
          name: 'NoNetworkRefDereference',
          description:
            'Client never requested tools/list, so $ref handling could not be evaluated',
          status: 'FAILURE',
          timestamp,
          errorMessage:
            'Client did not call tools/list against a server advertising a tool with a network $ref',
          specReferences: SPEC_REFERENCES,
          details: { toolsListed: false }
        }
      ];
    }

    return [
      {
        id: CHECK_ID,
        name: 'NoNetworkRefDereference',
        description: fetched
          ? 'Client automatically dereferenced a network-URI $ref in a tool inputSchema. Implementations MUST NOT automatically dereference $ref values that resolve to a network URI (SEP-2106).'
          : 'Client did not dereference the network-URI $ref in the tool inputSchema',
        status: fetched ? 'FAILURE' : 'SUCCESS',
        timestamp,
        errorMessage: fetched
          ? `Canary URL ${CANARY_PATH} was fetched ${this.canaryRequests.length} time(s)`
          : undefined,
        specReferences: SPEC_REFERENCES,
        details: {
          toolsListed: true,
          canaryRequestCount: this.canaryRequests.length,
          canaryRequests: this.canaryRequests
        }
      }
    ];
  }
}
