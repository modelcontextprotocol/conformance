/**
 * SEP-2663 Tasks Extension — client polymorphic-result handling.
 *
 * The mock server returns a server-directed CreateTaskResult from tools/call.
 * A conformant client follows the task handle with tasks/get and consumes the
 * completed result instead of treating the task envelope as a CallToolResult.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { ScenarioContext } from '../../mock-server';
import {
  validateStatelessRequest,
  withRequiredDraftResultFields
} from '../../mock-server';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type Scenario,
  type ScenarioUrls
} from '../../types';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const MISSING_REQUIRED_CLIENT_CAPABILITY = -32003;
const CREATED_AT = '2026-07-19T00:00:00.000Z';
const SEP_2663_REF = {
  id: 'SEP-2663',
  url: 'https://modelcontextprotocol.io/seps/2663-tasks-extension'
};

interface Observations {
  toolCallSeen: boolean;
  toolCallDeclaredExtension: boolean;
  taskGetIds: string[];
}

function clientDeclaredTasks(params: Record<string, unknown>): boolean {
  const meta = params._meta as Record<string, unknown> | undefined;
  const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'] as
    | Record<string, unknown>
    | undefined;
  const extensions = capabilities?.extensions as
    | Record<string, unknown>
    | undefined;
  return extensions?.[TASKS_EXTENSION_ID] !== undefined;
}

export class TasksClientCreateHandlingScenario implements Scenario {
  name = 'tasks-client-create-handling';
  readonly source = {
    extensionId: TASKS_EXTENSION_ID,
    baseSpecVersion: DRAFT_PROTOCOL_VERSION
  } as const;
  description =
    'Tests that a client declaring the SEP-2663 Tasks extension handles a server-directed CreateTaskResult from tools/call and retrieves the completed result with tasks/get.';

  private httpServer: HttpServer | null = null;
  private taskId = randomUUID();
  private observations: Observations = this.newObservations();

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.taskId = randomUUID();
    this.observations = this.newObservations();

    const app = express();
    app.use(express.json());

    const serverCapabilities = {
      tools: {},
      extensions: { [TASKS_EXTENSION_ID]: {} }
    };

    app.post('/mcp', (req, res) => {
      const validation = validateStatelessRequest(req, serverCapabilities, [
        ctx.specVersion
      ]);
      if (validation.kind !== 'route') {
        return res.status(validation.status).json(validation.body);
      }

      const { id, method, params } = validation;
      const error = (
        status: number,
        code: number,
        message: string,
        data?: Record<string, unknown>
      ) =>
        res.status(status).json({
          jsonrpc: '2.0',
          id,
          error: { code, message, ...(data ? { data } : {}) }
        });

      if (method === 'tools/list') {
        return res.json({
          jsonrpc: '2.0',
          id,
          result: withRequiredDraftResultFields(method, {
            tools: [
              {
                name: 'long_running_echo',
                description: 'Returns its result through an MCP task.',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text']
                }
              }
            ]
          })
        });
      }

      if (method === 'tools/call') {
        this.observations.toolCallSeen = true;
        this.observations.toolCallDeclaredExtension =
          clientDeclaredTasks(params);

        if (!this.observations.toolCallDeclaredExtension) {
          return error(
            400,
            MISSING_REQUIRED_CLIENT_CAPABILITY,
            `Missing required client capability: ${TASKS_EXTENSION_ID}`,
            {
              requiredCapabilities: {
                extensions: { [TASKS_EXTENSION_ID]: {} }
              }
            }
          );
        }

        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'task',
            taskId: this.taskId,
            status: 'working',
            createdAt: CREATED_AT,
            lastUpdatedAt: CREATED_AT,
            ttlMs: 60_000,
            pollIntervalMs: 1
          }
        });
      }

      if (method === 'tasks/get') {
        const taskId = params.taskId;
        if (typeof taskId !== 'string' || taskId !== this.taskId) {
          return error(400, -32602, 'Unknown taskId');
        }

        this.observations.taskGetIds.push(taskId);
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            taskId: this.taskId,
            status: 'completed',
            createdAt: CREATED_AT,
            lastUpdatedAt: CREATED_AT,
            ttlMs: 60_000,
            pollIntervalMs: 1,
            result: {
              resultType: 'complete',
              content: [{ type: 'text', text: 'task-result-ok' }]
            }
          }
        });
      }

      return error(404, -32601, `Method not found: ${method}`);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer = app.listen(0);
      this.httpServer.once('error', reject);
      this.httpServer.once('listening', resolve);
    });

    const server = this.httpServer;
    if (!server) throw new Error('Tasks conformance server did not start');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { serverUrl: `http://localhost:${port}/mcp` };
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    const server = this.httpServer;
    this.httpServer = null;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  getChecks(): ConformanceCheck[] {
    const polledCreatedTask = this.observations.taskGetIds.includes(
      this.taskId
    );
    const passed =
      this.observations.toolCallSeen &&
      this.observations.toolCallDeclaredExtension &&
      polledCreatedTask;

    let errorMessage: string | undefined;
    if (!this.observations.toolCallSeen) {
      errorMessage = 'Client did not issue tools/call.';
    } else if (!this.observations.toolCallDeclaredExtension) {
      errorMessage = `Client did not declare ${TASKS_EXTENSION_ID} in the tools/call per-request capabilities.`;
    } else if (!polledCreatedTask) {
      errorMessage =
        'Client received CreateTaskResult but did not retrieve it with tasks/get.';
    }

    return [
      {
        id: 'sep-2663-client-handles-polymorphic-result',
        name: 'TasksClientHandlesPolymorphicResult',
        description:
          'Client handles CreateTaskResult from tools/call and retrieves the completed task result with tasks/get.',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage,
        specReferences: [SEP_2663_REF],
        details: {
          toolCallSeen: this.observations.toolCallSeen,
          declaredTasksExtension: this.observations.toolCallDeclaredExtension,
          taskGetIds: [...this.observations.taskGetIds]
        }
      }
    ];
  }

  private newObservations(): Observations {
    return {
      toolCallSeen: false,
      toolCallDeclaredExtension: false,
      taskGetIds: []
    };
  }
}
