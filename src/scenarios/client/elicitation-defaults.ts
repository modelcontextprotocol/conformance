/**
 * SEP-1034: Client-side elicitation defaults test
 * Validates that clients apply default values for omitted fields in elicitation responses
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { Scenario, ConformanceCheck } from '../../types.js';
import express, { Request, Response } from 'express';
import { ScenarioUrls } from '../../types.js';
import { createRequestLogger } from '../request-logger.js';
import { z } from 'zod';

function createServer(checks: ConformanceCheck[]): express.Application {
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
      try {
        // Request elicitation with all optional fields having defaults
        const result = await server.request(
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
          z
            .object({ method: z.literal('elicitation/create') })
            .passthrough() as any
        );

        const elicitResult = result as any;

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
          description: 'Client applies string default value',
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
          description: 'Client applies integer default value',
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
          numberErrors.push('Field "score" missing - should have default 95.5');
        } else if (typeof content.score !== 'number') {
          numberErrors.push(
            `Expected number for "score", got ${typeof content.score}`
          );
        }

        checks.push({
          id: 'client-elicitation-sep1034-number-default',
          name: 'ClientElicitationSEP1034NumberDefault',
          description: 'Client applies number default value',
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
          description: 'Client applies enum default value',
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
          description: 'Client applies boolean default value',
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

export class ElicitationClientDefaultsScenario implements Scenario {
  name = 'elicitation-sep1034-client-defaults';
  description =
    'Tests client applies default values for omitted elicitation fields (SEP-1034)';
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
    const expectedSlugs = [
      'client-elicitation-sep1034-string-default',
      'client-elicitation-sep1034-integer-default',
      'client-elicitation-sep1034-number-default',
      'client-elicitation-sep1034-enum-default',
      'client-elicitation-sep1034-boolean-default'
    ];

    // Add failures for any checks that weren't triggered (tool not called)
    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name: slug.replace(/-/g, ''),
          description: `Validates client applies default for ${slug.split('-')[4]} type`,
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
