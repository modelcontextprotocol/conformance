import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Scenario, ConformanceCheck } from '../../types';
import express, { Request, Response } from 'express';
import { ScenarioUrls } from '../../types';
import { createRequestLogger } from '../request-logger';
import { randomUUID } from 'crypto';

function createMcpServer(checks: ConformanceCheck[]): Server {
  const server = new Server(
    {
      name: 'add-numbers-server',
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
      const { a, b } = request.params.arguments as { a: number; b: number };
      const result = a + b;

      checks.push({
        id: 'tool-add-numbers',
        name: 'ToolAddNumbers',
        description: 'Validates that the add_numbers tool works correctly',
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

function createApp(checks: ConformanceCheck[]): {
  app: express.Application;
  cleanup: () => void;
} {
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  const servers: { [sessionId: string]: Server } = {};

  const app = express();
  app.use(express.json());

  app.use(
    createRequestLogger(checks, {
      incomingId: 'incoming-request',
      outgoingId: 'outgoing-response',
      mcpRoute: '/mcp'
    })
  );

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const mcpServer = createMcpServer(checks);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = mcpServer;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            servers[sid].close();
            delete servers[sid];
          }
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else if (sessionId) {
      // Invalid/stale session ID → 404
      res.status(404).json({ error: 'Session not found' });
    } else {
      // Non-initialization request without session ID → 400
      res.status(400).json({ error: 'Bad request' });
    }
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  const cleanup = () => {
    for (const sid in servers) {
      servers[sid].close();
    }
  };

  return { app, cleanup };
}

export class ToolsCallScenario implements Scenario {
  name = 'tools_call';
  description = 'Tests calling tools with various parameter types';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private checks: ConformanceCheck[] = [];
  private cleanup: (() => void) | null = null;

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    const result = createApp(this.checks);
    this.app = result.app;
    this.cleanup = result.cleanup;
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    return { serverUrl: `http://localhost:${port}/mcp` };
  }

  async stop() {
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = ['tool-add-numbers'];
    // add a failure if not in there already
    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        // TODO: this is duplicated from above, refactor
        this.checks.push({
          id: slug,
          name: `ToolAddNumbers`,
          description: `Validates that the add_numbers tool works correctly`,
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
    }
    return this.checks;
  }
}
