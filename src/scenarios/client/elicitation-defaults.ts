import type { ScenarioContext } from '../../mock-server';
/**
 * SEP-1034: Elicitation defaults test
 * Validates that clients properly apply default values for omitted fields
 * in elicitation responses before sending them to the server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ElicitResultSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { Scenario, ConformanceCheck } from '../../types';
import express, { Request, Response } from 'express';
import { ScenarioUrls, DRAFT_PROTOCOL_VERSION } from '../../types';
import { createRequestLogger } from '../request-logger';
import { randomUUID } from 'crypto';

function isInitializeRequest(body: unknown): boolean {
  if (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    (body as { method: string }).method === 'initialize'
  ) {
    return true;
  }
  return false;
}

/**
 * Whether the client's `initialize` request declared the `elicitation`
 * capability. This scenario only runs at 2025-11-25, where `elicitation` is
 * a single object capability (the form/url sub-split arrives in the draft
 * revision), so any declared value other than `null`/`false` counts.
 * Defaults to `true` when the request shape is unreadable so behaviour is
 * unchanged for clients that negotiated elicitation normally.
 */
function declaresElicitation(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return true;
  }
  const capabilities = (body as { params?: { capabilities?: unknown } }).params
    ?.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    return true;
  }
  const elicitation = (capabilities as Record<string, unknown>).elicitation;
  return (
    elicitation !== undefined && elicitation !== null && elicitation !== false
  );
}

const SEP1034_SPEC_REFERENCES = [
  {
    id: 'SEP-1034',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
  }
];

const ELICITATION_NOT_DECLARED_MESSAGE =
  'Client did not declare the elicitation capability during initialize; check not applicable';

function skippedElicitationCheck(
  id: string,
  name: string,
  description: string
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage: ELICITATION_NOT_DECLARED_MESSAGE,
    specReferences: SEP1034_SPEC_REFERENCES
  };
}

function createServer(checks: ConformanceCheck[]): {
  app: express.Application;
  cleanup: () => void;
  elicitationDeclared: () => boolean;
} {
  // Session management
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  const servers: { [sessionId: string]: Server } = {};

  // Elicitation is an optional client capability; a client that did not
  // declare it is not applicable for this scenario rather than failing it.
  let elicitationDeclared = true;

  const createMcpServer = () => {
    const server = new Server(
      {
        name: 'elicitation-defaults-test-server',
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
            name: 'test_client_elicitation_defaults',
            description:
              'Tests that client applies defaults for omitted elicitation fields',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'test_client_elicitation_defaults') {
        if (!elicitationDeclared) {
          // The client negotiated without the optional elicitation
          // capability, so it must not receive `elicitation/create` and the
          // checks are not applicable rather than failed.
          checks.push(
            skippedElicitationCheck(
              'client-elicitation-sep1034-general',
              'ClientElicitationSEP1034General',
              'Client handles elicitation with defaults'
            ),
            skippedElicitationCheck(
              'client-elicitation-sep1034-string-default',
              'ClientElicitationSEP1034StringDefault',
              'Client applies string default value for elicitation'
            ),
            skippedElicitationCheck(
              'client-elicitation-sep1034-integer-default',
              'ClientElicitationSEP1034IntegerDefault',
              'Client applies integer default value for elicitation'
            ),
            skippedElicitationCheck(
              'client-elicitation-sep1034-number-default',
              'ClientElicitationSEP1034NumberDefault',
              'Client applies number default value for elicitation'
            ),
            skippedElicitationCheck(
              'client-elicitation-sep1034-enum-default',
              'ClientElicitationSEP1034EnumDefault',
              'Client applies enum default value for elicitation'
            ),
            skippedElicitationCheck(
              'client-elicitation-sep1034-boolean-default',
              'ClientElicitationSEP1034BooleanDefault',
              'Client applies boolean default value for elicitation'
            )
          );
          return {
            content: [
              {
                type: 'text',
                text: 'Elicitation capability not declared by client; checks skipped'
              }
            ]
          };
        }
        try {
          // Request elicitation with all optional fields having defaults
          // Using raw server.request() to verify client applies defaults before sending response
          const elicitResult = await server.request(
            {
              method: 'elicitation/create',
              params: {
                message:
                  'Test client default value handling - please accept with defaults',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'User name',
                      default: 'John Doe'
                    },
                    age: {
                      type: 'integer',
                      description: 'User age',
                      default: 30
                    },
                    score: {
                      type: 'number',
                      description: 'User score',
                      default: 95.5
                    },
                    status: {
                      type: 'string',
                      description: 'User status',
                      enum: ['active', 'inactive', 'pending'],
                      default: 'active'
                    },
                    verified: {
                      type: 'boolean',
                      description: 'Verification status',
                      default: true
                    }
                  },
                  required: [] // All fields optional, so defaults should apply
                }
              }
            },
            ElicitResultSchema
          );

          // Check if elicitation was accepted
          if (elicitResult.action !== 'accept') {
            checks.push({
              id: 'client-elicitation-sep1034-general',
              name: 'ClientElicitationSEP1034General',
              description: 'Client accepts elicitation request',
              status: 'FAILURE',
              timestamp: new Date().toISOString(),
              errorMessage: `Expected action 'accept', got '${elicitResult.action}'`,
              specReferences: [
                {
                  id: 'SEP-1034',
                  url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
                }
              ]
            });
            return {
              content: [{ type: 'text', text: 'Elicitation was not accepted' }]
            };
          }

          const content = elicitResult.content || {};

          // Validate string default was applied
          const stringErrors: string[] = [];
          if (!('name' in content)) {
            stringErrors.push(
              'Field "name" missing - should have default "John Doe"'
            );
          } else if (typeof content.name !== 'string') {
            stringErrors.push(
              `Expected string for "name", got ${typeof content.name}`
            );
          }

          checks.push({
            id: 'client-elicitation-sep1034-string-default',
            name: 'ClientElicitationSEP1034StringDefault',
            description: 'Client applies string default value for elicitation',
            status: stringErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              stringErrors.length > 0 ? stringErrors.join('; ') : undefined,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ],
            details: {
              field: 'name',
              expectedDefault: 'John Doe',
              receivedValue: content.name
            }
          });

          // Validate integer default was applied
          const integerErrors: string[] = [];
          if (!('age' in content)) {
            integerErrors.push('Field "age" missing - should have default 30');
          } else if (typeof content.age !== 'number') {
            integerErrors.push(
              `Expected number for "age", got ${typeof content.age}`
            );
          }

          checks.push({
            id: 'client-elicitation-sep1034-integer-default',
            name: 'ClientElicitationSEP1034IntegerDefault',
            description: 'Client applies integer default value for elicitation',
            status: integerErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              integerErrors.length > 0 ? integerErrors.join('; ') : undefined,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ],
            details: {
              field: 'age',
              expectedDefault: 30,
              receivedValue: content.age
            }
          });

          // Validate number default was applied
          const numberErrors: string[] = [];
          if (!('score' in content)) {
            numberErrors.push(
              'Field "score" missing - should have default 95.5'
            );
          } else if (typeof content.score !== 'number') {
            numberErrors.push(
              `Expected number for "score", got ${typeof content.score}`
            );
          }

          checks.push({
            id: 'client-elicitation-sep1034-number-default',
            name: 'ClientElicitationSEP1034NumberDefault',
            description: 'Client applies number default value for elicitation',
            status: numberErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              numberErrors.length > 0 ? numberErrors.join('; ') : undefined,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ],
            details: {
              field: 'score',
              expectedDefault: 95.5,
              receivedValue: content.score
            }
          });

          // Validate enum default was applied
          const enumErrors: string[] = [];
          if (!('status' in content)) {
            enumErrors.push(
              'Field "status" missing - should have default "active"'
            );
          } else if (typeof content.status !== 'string') {
            enumErrors.push(
              `Expected string for "status", got ${typeof content.status}`
            );
          } else if (
            !['active', 'inactive', 'pending'].includes(content.status)
          ) {
            enumErrors.push(
              `Value "${content.status}" is not a valid enum member`
            );
          }

          checks.push({
            id: 'client-elicitation-sep1034-enum-default',
            name: 'ClientElicitationSEP1034EnumDefault',
            description: 'Client applies enum default value for elicitation',
            status: enumErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              enumErrors.length > 0 ? enumErrors.join('; ') : undefined,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ],
            details: {
              field: 'status',
              expectedDefault: 'active',
              receivedValue: content.status
            }
          });

          // Validate boolean default was applied
          const booleanErrors: string[] = [];
          if (!('verified' in content)) {
            booleanErrors.push(
              'Field "verified" missing - should have default true'
            );
          } else if (typeof content.verified !== 'boolean') {
            booleanErrors.push(
              `Expected boolean for "verified", got ${typeof content.verified}`
            );
          }

          checks.push({
            id: 'client-elicitation-sep1034-boolean-default',
            name: 'ClientElicitationSEP1034BooleanDefault',
            description: 'Client applies boolean default value for elicitation',
            status: booleanErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              booleanErrors.length > 0 ? booleanErrors.join('; ') : undefined,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ],
            details: {
              field: 'verified',
              expectedDefault: true,
              receivedValue: content.verified
            }
          });

          return {
            content: [
              {
                type: 'text',
                text: `Elicitation completed: ${JSON.stringify(content)}`
              }
            ]
          };
        } catch (error: any) {
          checks.push({
            id: 'client-elicitation-sep1034-general',
            name: 'ClientElicitationSEP1034General',
            description: 'Client handles elicitation with defaults',
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: `Elicitation failed: ${error.message}`,
            specReferences: [
              {
                id: 'SEP-1034',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
              }
            ]
          });

          return {
            content: [
              {
                type: 'text',
                text: `Elicitation error: ${error.message}`
              }
            ]
          };
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });

    return server;
  };

  const app = express();
  app.use(express.json());

  app.use(
    createRequestLogger(checks, {
      incomingId: 'incoming-request',
      outgoingId: 'outgoing-response',
      mcpRoute: '/mcp'
    })
  );

  // Handle POST requests - stateful mode
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for established sessions
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        elicitationDeclared = declaresElicitation(req.body);
        // Create new transport for initialization requests
        const mcpServer = createMcpServer();

        transport = new StreamableHTTPServerTransport({
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
        return;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Invalid or missing session ID'
          },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // Handle GET requests - SSE streams for sessions
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).send('Error establishing SSE stream');
      }
    }
  });

  // Handle DELETE requests - session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).send('Error handling termination');
      }
    }
  });

  const cleanup = () => {
    // Clean up all sessions
    for (const sessionId of Object.keys(transports)) {
      if (servers[sessionId]) {
        servers[sessionId].close();
      }
    }
  };

  return { app, cleanup, elicitationDeclared: () => elicitationDeclared };
}

export class ElicitationClientDefaultsScenario implements Scenario {
  name = 'elicitation-sep1034-client-defaults';
  readonly source = {
    introducedIn: '2025-11-25',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description =
    'Tests client applies default values for omitted elicitation fields (SEP-1034)';
  private app: express.Application | null = null;
  private httpServer: any = null;
  private checks: ConformanceCheck[] = [];
  private cleanup: (() => void) | null = null;
  private elicitationDeclared: () => boolean = () => true;

  async start(_ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.checks = [];
    const { app, cleanup, elicitationDeclared } = createServer(this.checks);
    this.app = app;
    this.cleanup = cleanup;
    this.elicitationDeclared = elicitationDeclared;
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
    const expectedSlugs = [
      'client-elicitation-sep1034-string-default',
      'client-elicitation-sep1034-integer-default',
      'client-elicitation-sep1034-number-default',
      'client-elicitation-sep1034-enum-default',
      'client-elicitation-sep1034-boolean-default'
    ];

    if (!this.elicitationDeclared()) {
      // The client never declared the optional elicitation capability: the
      // general check plus any untriggered defaults are SKIPPED, not failed.
      if (
        !this.checks.find((c) => c.id === 'client-elicitation-sep1034-general')
      ) {
        this.checks.push(
          skippedElicitationCheck(
            'client-elicitation-sep1034-general',
            'ClientElicitationSEP1034General',
            'Client handles elicitation with defaults'
          )
        );
      }
      for (const slug of expectedSlugs) {
        if (!this.checks.find((c) => c.id === slug)) {
          this.checks.push(
            skippedElicitationCheck(
              slug,
              slug.replace(/-/g, ''),
              `Server applies ${slug.split('-')[4]} default for elicitation`
            )
          );
        }
      }
      return this.checks;
    }

    // Add failures for any checks that weren't triggered (tool not called)
    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name: slug.replace(/-/g, ''),
          description: `Server applies ${slug.split('-')[4]} default for elicitation`,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          details: { message: 'Tool was not called by client' },
          specReferences: [
            {
              id: 'SEP-1034',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
            }
          ]
        });
      }
    }
    return this.checks;
  }
}
