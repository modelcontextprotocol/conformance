import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { Scenario, ConformanceCheck, SpecVersion } from '../../types';
import express, { Request, Response } from 'express';
import { ScenarioUrls } from '../../types';
import { createRequestLogger } from '../request-logger';

function createServer(checks: ConformanceCheck[]): express.Application {
  // Factory: new Server per request (stateless = no shared state)
  function getServer(): Server {
    const server = new Server(
      {
        name: 'stateless-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'add_numbers',
            description: 'Add two numbers together',
            inputSchema: {
              type: 'object',
              properties: {
                a: {
                  type: 'number',
                  description: 'First number'
                },
                b: {
                  type: 'number',
                  description: 'Second number'
                }
              },
              required: ['a', 'b']
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'add_numbers') {
        const { a, b } = request.params.arguments as {
          a: number;
          b: number;
        };
        const result = a + b;

        checks.push({
          id: 'stateless-tools-call',
          name: 'StatelessToolsCall',
          description:
            'Validates that the client can call a tool on a stateless server',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'MCP-Tools',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
            }
          ],
          details: {
            a,
            b,
            result
          }
        });

        return {
          content: [
            {
              type: 'text',
              text: `The sum of ${a} and ${b} is ${result}`
            }
          ]
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });

    return server;
  }

  const app = express();
  app.use(express.json());

  app.use(
    createRequestLogger(checks, {
      incomingId: 'incoming-request',
      outgoingId: 'outgoing-response',
      mcpRoute: '/mcp'
    })
  );

  let isFirstPost = true;

  app.post('/mcp', async (req: Request, res: Response) => {
    if (!isFirstPost) {
      const clientSessionHeader = req.headers['mcp-session-id'];
      if (clientSessionHeader) {
        checks.push({
          id: 'stateless-no-session-header-sent',
          name: 'StatelessNoSessionHeaderSent',
          description:
            'Client omits mcp-session-id when server did not provide one',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Client sent mcp-session-id: ${clientSessionHeader}`,
          specReferences: [
            {
              id: 'MCP-Session',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
            }
          ]
        });
      } else if (
        !checks.find((c) => c.id === 'stateless-no-session-header-sent')
      ) {
        checks.push({
          id: 'stateless-no-session-header-sent',
          name: 'StatelessNoSessionHeaderSent',
          description:
            'Client omits mcp-session-id when server did not provide one',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'MCP-Session',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
            }
          ]
        });
      }
    }
    isFirstPost = false;

    const server = getServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  });

  app.get('/mcp', async (_req: Request, res: Response) => {
    checks.push({
      id: 'stateless-get-405',
      name: 'StatelessGet405',
      description:
        'Stateless server returns 405 for GET (no SSE stream without sessions)',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'MCP-Session',
          url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
        }
      ]
    });

    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.'
        },
        id: null
      })
    );
  });

  app.delete('/mcp', async (_req: Request, res: Response) => {
    checks.push({
      id: 'stateless-delete-405',
      name: 'StatelessDelete405',
      description:
        'Stateless server returns 405 for DELETE (no session to terminate)',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        {
          id: 'MCP-Session',
          url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
        }
      ]
    });

    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.'
        },
        id: null
      })
    );
  });

  return app;
}

export class StatelessServerScenario implements Scenario {
  name = 'stateless_server';
  specVersions: SpecVersion[] = ['2025-03-26', '2025-06-18', '2025-11-25'];
  description = 'Tests that clients handle a stateless server (no session ID)';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.app = createServer(this.checks);
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    return { serverUrl: `http://localhost:${port}/mcp` };
  }

  async stop() {
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    // Server never sends mcp-session-id with sessionIdGenerator: undefined
    if (!this.checks.find((c) => c.id === 'stateless-init-no-session')) {
      this.checks.push({
        id: 'stateless-init-no-session',
        name: 'StatelessInitNoSession',
        description:
          'Server response contains no mcp-session-id header (stateless)',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    if (!this.checks.find((c) => c.id === 'stateless-no-session-header-sent')) {
      this.checks.push({
        id: 'stateless-no-session-header-sent',
        name: 'StatelessNoSessionHeaderSent',
        description:
          'Client omits mcp-session-id when server did not provide one',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    if (!this.checks.find((c) => c.id === 'stateless-get-405')) {
      this.checks.push({
        id: 'stateless-get-405',
        name: 'StatelessGet405',
        description:
          'Stateless server returns 405 for GET (client did not attempt GET)',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    if (!this.checks.find((c) => c.id === 'stateless-delete-405')) {
      this.checks.push({
        id: 'stateless-delete-405',
        name: 'StatelessDelete405',
        description:
          'Stateless server returns 405 for DELETE (client did not attempt DELETE)',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Session',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management'
          }
        ]
      });
    }

    if (!this.checks.find((c) => c.id === 'stateless-tools-call')) {
      this.checks.push({
        id: 'stateless-tools-call',
        name: 'StatelessToolsCall',
        description:
          'Validates that the client can call a tool on a stateless server',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        details: { message: 'Tool was not called by client' },
        specReferences: [
          {
            id: 'MCP-Tools',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return this.checks;
  }
}
