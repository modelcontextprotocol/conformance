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
 *
 * The first call and its retry may reach different processes of a
 * multi-process host that share no memory. The only state the retry needs,
 * the original request id and the exact requestState, travels inside the
 * requestState the server sends, with a digest so any process can rebuild
 * the expected string and compare it byte for byte.
 */

import type { ConformanceCheck, RequestListener } from '../../types';
import { HandlerScenario, DRAFT_PROTOCOL_VERSION } from '../../types';
import express, { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';

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
  },
  {
    name: 'test_mrtr_no_result_type',
    description:
      'Test tool: returns a result without resultType. Client must treat it as complete (default).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
    }
  }
];

const EXPECTED_CHECK_IDS = [
  'sep-2322-client-request-state-echoed',
  'sep-2322-client-jsonrpc-id-different',
  'sep-2322-client-no-state-omitted',
  'sep-2322-client-parallel-isolation',
  'sep-2322-default-result-type-complete'
];

/**
 * INFO record of the first echo_state call, a fallback for its retry. Not
 * prefixed with the SEP: it is the server's bookkeeping, not a requirement.
 */
const ECHO_INITIAL_CHECK_ID = 'mrtr-echo-state-initial';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * The requestState sent on the first echo_state call: the call's id and a
 * nonce, plus a digest over both, in a fixed key order. Rebuilding it from
 * the fields a client echoed reproduces the exact string only if the client
 * left it untouched: re-serialized JSON changes the bytes, and an edited id
 * or nonce changes the digest.
 */
function echoState(originalId: string | number, nonce: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ nonce, originalId }))
    .digest('base64url')
    .slice(0, 22);
  return JSON.stringify({ nonce, originalId, digest });
}

/** The state this server would have sent for the fields in `state`, if any. */
function rebuildEchoState(
  state: string
): { originalId: string | number; expected: string } | undefined {
  try {
    const parsed = JSON.parse(state) as Record<string, unknown>;
    const { nonce, originalId } = parsed;
    if (typeof nonce !== 'string') return undefined;
    if (typeof originalId !== 'string' && typeof originalId !== 'number')
      return undefined;
    return { originalId, expected: echoState(originalId, nonce) };
  } catch {
    return undefined;
  }
}

function createMRTRServer(checks: ConformanceCheck[]): express.Application {
  const app = express();
  app.use(express.json());

  app.post('/mcp', (req: Request, res: Response) => {
    const body = req.body as JsonRpcRequest;
    const { id, method, params } = body;

    switch (method) {
      case 'server/discover': {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            supportedVersions: [DRAFT_PROTOCOL_VERSION],
            capabilities: { tools: {} },
            serverInfo: { name: 'mrtr-mock-server', version: '1.0.0' }
          }
        });
        return;
      }

      case 'notifications/initialized': {
        res.status(204).end();
        return;
      }

      case 'tools/list': {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: TOOLS
          }
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

        if (toolName === 'test_mrtr_no_result_type') {
          handleNoResultType(id, inputResponses, checks, res);
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
          result: {
            resultType: 'complete',
            action: 'accept',
            content: { confirmed: true }
          }
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
      // Initial call: return InputRequiredResult with a requestState that
      // carries this call's id, and note both in the log as a fallback.
      const state = echoState(id, randomUUID());
      checks.push({
        id: ECHO_INITIAL_CHECK_ID,
        name: 'MRTREchoStateInitialCall',
        description:
          'The server answered the first test_mrtr_echo_state call with a requestState',
        status: 'INFO',
        timestamp: new Date().toISOString(),
        specReferences: MRTR_SPEC_REFERENCES,
        details: { originalId: id, requestStateSent: state }
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

    // Retry: what was sent comes from the echoed state itself when it is
    // exactly what this server would have sent, or failing that from the log
    // of the first call (possibly another process's). A state that does not
    // rebuild byte for byte is never believed, so an edited originalId cannot
    // steer the id check.
    const rebuilt = requestState ? rebuildEchoState(requestState) : undefined;
    const intact =
      rebuilt && rebuilt.expected === requestState ? rebuilt : undefined;
    const initial = [...checks]
      .reverse()
      .find((c) => c.id === ECHO_INITIAL_CHECK_ID)?.details as
      | { originalId?: string | number; requestStateSent?: string }
      | undefined;
    const originalId = intact?.originalId ?? initial?.originalId;
    const sentState = intact?.expected ?? initial?.requestStateSent;

    // Check 1: requestState must be present and byte-for-byte identical to
    // what the server sent. The spec requires the client to echo back the
    // *exact value* without inspecting, parsing, or modifying it — so a
    // semantically-equal but re-serialized string is still a failure.
    const stateErrors: string[] = [];
    if (!requestState) {
      stateErrors.push('Client did not include requestState in retry');
    } else if (requestState !== sentState) {
      stateErrors.push(
        'requestState was not echoed back exactly — clients MUST NOT inspect, parse, or modify it'
      );
    }

    checks.push({
      id: 'sep-2322-client-request-state-echoed',
      name: 'MRTRClientRequestStateEchoed',
      description:
        'Client MUST echo back the exact value of requestState when retrying',
      status: stateErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: stateErrors.length > 0 ? stateErrors.join('; ') : undefined,
      specReferences: MRTR_SPEC_REFERENCES,
      details: {
        requestStateSent: sentState,
        requestStateReceived: requestState,
        originalId
      }
    });

    // Check 2: JSON-RPC id must differ from original. When the original id
    // cannot be recovered (no intact state and no record of the first call)
    // there is nothing to compare, and check 1 has already failed the retry.
    const idErrors: string[] = [];
    if (originalId !== undefined && id === originalId) {
      idErrors.push(
        `JSON-RPC id is the same on retry (${id}) — MUST be different`
      );
    }

    checks.push({
      id: 'sep-2322-client-jsonrpc-id-different',
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
        resultType: 'complete',
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
      id: 'sep-2322-client-no-state-omitted',
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
        resultType: 'complete',
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
      id: 'sep-2322-client-parallel-isolation',
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
        resultType: 'complete',
        content: [{ type: 'text', text: 'unrelated-ok' }]
      }
    });
  }

  function handleNoResultType(
    id: string | number,
    inputResponses: Record<string, unknown> | undefined,
    checks: ConformanceCheck[],
    res: Response
  ) {
    const checkId = 'sep-2322-default-result-type-complete';

    // If the client retries this tool, it did NOT treat the result as
    // complete. The SUCCESS noted for the first answer may sit in another
    // process's log, so it is not removed here: getChecks() lets the
    // FAILURE win.
    if (inputResponses) {
      checks.push({
        id: checkId,
        name: 'DefaultResultTypeComplete',
        description:
          'Client MUST assume resultType "complete" when not specified',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          'Client retried with inputResponses even though the result had no resultType (should default to complete)',
        specReferences: MRTR_SPEC_REFERENCES
      });
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          content: [{ type: 'text', text: 'unexpected-retry' }]
        }
      });
      return;
    }

    // Return a result WITHOUT resultType — client should treat as complete
    checks.push({
      id: checkId,
      name: 'DefaultResultTypeComplete',
      description:
        'Client MUST assume resultType "complete" when not specified',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: MRTR_SPEC_REFERENCES
    });

    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        // Deliberately NO resultType field
        content: [{ type: 'text', text: 'no-result-type-test-ok' }]
      }
    });
  }

  return app;
}

export class MRTRClientScenario extends HandlerScenario {
  name = 'sep-2322-client-request-state';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Tests client MRTR behavior: requestState echo, no-state omission, and JSON-RPC id uniqueness (SEP-2322)';
  mcpPath = '/mcp';
  private checks: ConformanceCheck[] = [];

  /** What a client driven by hand (or by a generic steps interpreter) should do. */
  readonly steps = [
    { op: 'tools/list' },
    { op: 'tools/call', name: 'test_mrtr_echo_state' },
    { op: 'tools/call', name: 'test_mrtr_unrelated' },
    { op: 'tools/call', name: 'test_mrtr_no_state' },
    { op: 'tools/call', name: 'test_mrtr_no_result_type' }
  ] as const;

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    return createMRTRServer(this.checks);
  }

  /**
   * One row per check id, built fresh so the raw log stays as observed: a
   * FAILURE wins over any SUCCESS for the same id (a merged log from several
   * processes can hold both), otherwise the latest row. Expected checks that
   * never ran are reported as FAILURE.
   */
  getChecks(): ConformanceCheck[] {
    const byId = new Map<string, ConformanceCheck>();
    for (const check of this.checks) {
      const previous = byId.get(check.id);
      if (!previous || previous.status !== 'FAILURE') byId.set(check.id, check);
    }
    const result = [...byId.values()];
    for (const slug of EXPECTED_CHECK_IDS) {
      if (byId.has(slug)) continue;
      result.push({
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
    return result;
  }
}
