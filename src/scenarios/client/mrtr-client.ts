/**
 * SEP-2322: MRTR Client Conformance Tests
 *
 * Tests that clients correctly handle the MRTR (Multi-Round Tool Resolution) flow:
 * - Echo requestState back unchanged when retrying
 * - Don't include requestState when server didn't send one
 * - Use a different JSON-RPC id on retry
 *
 * The server exposes two tools. The client calls each tool, gets InputRequiredResult,
 * fulfills the elicitation, and retries. The server verifies correct client behavior.
 */

import type { Scenario, ConformanceCheck } from '../../types';
import { DRAFT_PROTOCOL_VERSION, ScenarioUrls } from '../../types';
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';

const MRTR_SPEC_REFERENCES = [
  {
    id: 'SEP-2322-MRTR',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/utilities/mrtr'
  }
];

const TOOLS = [
  {
    name: 'test_mrtr_echo_state',
    description:
      'Test tool: triggers MRTR flow with requestState. Client must echo state back unchanged.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
    }
  },
  {
    name: 'test_mrtr_no_state',
    description:
      'Test tool: triggers MRTR flow WITHOUT requestState. Client must NOT include requestState in retry.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
    }
  },
  {
    name: 'test_mrtr_unrelated',
    description:
      'Test tool: simple tool called between MRTR rounds. Must NOT carry inputResponses or requestState from another tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
    }
  }
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function createMRTRServer(checks: ConformanceCheck[]): express.Application {
  const app = express();
  app.use(express.json());

  // Track original JSON-RPC ids per tool to verify they change on retry
  const originalIds = new Map<string, string | number>();

  app.post('/mcp', (req: Request, res: Response) => {
    const body = req.body as JsonRpcRequest;
    const { id, method, params } = body;

    switch (method) {
      case 'notifications/initialized': {
        res.status(204).end();
        return;
      }

      case 'tools/list': {
        res.json({
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS }
        });
        return;
      }

      case 'tools/call': {
        const toolName = (params as Record<string, unknown>)?.name as string;
        const inputResponses = (params as Record<string, unknown>)
          ?.inputResponses as Record<string, unknown> | undefined;
        const requestState = (params as Record<string, unknown>)
          ?.requestState as string | undefined;

        if (toolName === 'test_mrtr_echo_state') {
          handleEchoState(id, inputResponses, requestState, checks, res);
          return;
        }

        if (toolName === 'test_mrtr_no_state') {
          handleNoState(id, inputResponses, requestState, checks, res);
          return;
        }

        if (toolName === 'test_mrtr_unrelated') {
          handleUnrelated(inputResponses, requestState, checks, res, id);
          return;
        }

        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` }
        });
        return;
      }

      case 'elicitation/create': {
        // Client is fulfilling our ElicitRequest — accept it
        res.json({
          jsonrpc: '2.0',
          id,
          result: { action: 'accept', content: { confirmed: true } }
        });
        return;
      }

      default: {
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
        return;
      }
    }
  });

  function handleEchoState(
    id: string | number,
    inputResponses: Record<string, unknown> | undefined,
    requestState: string | undefined,
    checks: ConformanceCheck[],
    res: Response
  ) {
    if (!inputResponses) {
      // Initial call — store original id, return InputRequiredResult with requestState
      originalIds.set('echo_state', id);
      const state = JSON.stringify({
        nonce: randomUUID(),
        originalId: id
      });
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'input_required',
          inputRequests: {
            confirm: {
              method: 'elicitation/create',
              params: {
                message: 'Please confirm to continue',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    confirmed: { type: 'boolean', description: 'Confirm?' }
                  }
                }
              }
            }
          },
          requestState: state
        }
      });
      return;
    }

    // Retry — verify requestState was echoed back correctly
    const originalId = originalIds.get('echo_state');

    // Check 1: requestState must be present and unchanged
    const stateErrors: string[] = [];
    if (!requestState) {
      stateErrors.push('Client did not include requestState in retry');
    } else {
      try {
        const parsed = JSON.parse(requestState) as Record<string, unknown>;
        if (parsed.originalId !== originalId) {
          stateErrors.push(
            `requestState was modified: originalId mismatch (expected ${originalId}, got ${parsed.originalId})`
          );
        }
        if (!parsed.nonce) {
          stateErrors.push('requestState was modified: nonce missing');
        }
      } catch {
        stateErrors.push(
          `requestState was modified or corrupted: cannot parse`
        );
      }
    }

    checks.push({
      id: 'mrtr-client-request-state-echoed',
      name: 'MRTRClientRequestStateEchoed',
      description:
        'Client MUST echo back the exact value of requestState when retrying',
      status: stateErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: stateErrors.length > 0 ? stateErrors.join('; ') : undefined,
      specReferences: MRTR_SPEC_REFERENCES,
      details: {
        requestStateReceived: requestState,
        originalId
      }
    });

    // Check 2: JSON-RPC id must differ from original
    const idErrors: string[] = [];
    if (id === originalId) {
      idErrors.push(
        `JSON-RPC id is the same on retry (${id}) — MUST be different`
      );
    }

    checks.push({
      id: 'mrtr-client-jsonrpc-id-different',
      name: 'MRTRClientJsonRpcIdDifferent',
      description:
        'The JSON-RPC id MUST be different between the initial request and the retry',
      status: idErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: idErrors.length > 0 ? idErrors.join('; ') : undefined,
      specReferences: MRTR_SPEC_REFERENCES,
      details: {
        originalId,
        retryId: id
      }
    });

    // Return complete result
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'echo-state-ok' }]
      }
    });
  }

  function handleNoState(
    id: string | number,
    inputResponses: Record<string, unknown> | undefined,
    requestState: string | undefined,
    checks: ConformanceCheck[],
    res: Response
  ) {
    if (!inputResponses) {
      // Initial call — return InputRequiredResult WITHOUT requestState
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'input_required',
          inputRequests: {
            confirm: {
              method: 'elicitation/create',
              params: {
                message: 'Please confirm to continue (no state test)',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    confirmed: { type: 'boolean', description: 'Confirm?' }
                  }
                }
              }
            }
          }
          // No requestState field!
        }
      });
      return;
    }

    // Retry — verify client did NOT include requestState
    const errors: string[] = [];
    if (requestState !== undefined) {
      errors.push(
        `Client included requestState ("${requestState}") but server did not send one — MUST NOT include it`
      );
    }

    checks.push({
      id: 'mrtr-client-no-state-omitted',
      name: 'MRTRClientNoStateOmitted',
      description:
        'If InputRequiredResult does not contain requestState, client MUST NOT include one in the retry',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: MRTR_SPEC_REFERENCES,
      details: {
        requestStateReceived: requestState
      }
    });

    // Return complete result
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'no-state-ok' }]
      }
    });
  }

  function handleUnrelated(
    inputResponses: Record<string, unknown> | undefined,
    requestState: string | undefined,
    checks: ConformanceCheck[],
    res: Response,
    id: string | number
  ) {
    // This tool should NEVER receive inputResponses or requestState —
    // those belong to a different tool's MRTR flow
    const errors: string[] = [];
    if (inputResponses !== undefined) {
      errors.push(
        `Unrelated tool call included inputResponses from another tool's MRTR flow`
      );
    }
    if (requestState !== undefined) {
      errors.push(
        `Unrelated tool call included requestState from another tool's MRTR flow`
      );
    }

    checks.push({
      id: 'mrtr-client-parallel-isolation',
      name: 'MRTRClientParallelIsolation',
      description:
        'inputRequests and requestState MUST NOT be used for any other request the client may be sending',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: MRTR_SPEC_REFERENCES,
      details: {
        inputResponsesReceived: inputResponses,
        requestStateReceived: requestState
      }
    });

    // Return a normal complete result
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'unrelated-ok' }]
      }
    });
  }

  return app;
}

export class MRTRClientScenario implements Scenario {
  name = 'mrtr-client-request-state';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests client MRTR behavior: requestState echo, no-state omission, and JSON-RPC id uniqueness (SEP-2322)';
  private app: express.Application | null = null;
  private httpServer: ReturnType<express.Application['listen']> | null = null;
  private checks: ConformanceCheck[] = [];

  async start(): Promise<ScenarioUrls> {
    this.checks = [];
    this.app = createMRTRServer(this.checks);
    this.httpServer = this.app.listen(0);
    const addr = this.httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { serverUrl: `http://localhost:${port}/mcp` };
  }

  async stop() {
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer!.close(resolve));
      this.httpServer = null;
    }
    this.app = null;
  }

  getChecks(): ConformanceCheck[] {
    const expectedSlugs = [
      'mrtr-client-request-state-echoed',
      'mrtr-client-jsonrpc-id-different',
      'mrtr-client-no-state-omitted',
      'mrtr-client-parallel-isolation'
    ];

    for (const slug of expectedSlugs) {
      if (!this.checks.find((c) => c.id === slug)) {
        this.checks.push({
          id: slug,
          name: slug,
          description: `MRTR client check: ${slug}`,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          details: {
            message: 'Tool was not called by client or MRTR flow not completed'
          },
          specReferences: MRTR_SPEC_REFERENCES
        });
      }
    }
    return this.checks;
  }
}
