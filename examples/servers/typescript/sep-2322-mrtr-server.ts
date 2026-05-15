#!/usr/bin/env node

/**
 * SEP-2322 MRTR Reference Server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  StreamableHTTPServerTransport,
  EventStore,
  EventId,
  StreamId
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  CancelTaskRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';

interface InputRequest {
  method: string;
  params?: Record<string, unknown>;
}

const ExtendedCallToolRequestSchema = z.object({
  method: z.literal('tools/call'),
  params: z
    .object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      task: z.object({ ttl: z.number().optional() }).passthrough().optional(),
      _meta: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough()
});

const ExtendedGetPromptRequestSchema = z.object({
  method: z.literal('prompts/get'),
  params: z
    .object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      _meta: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough()
});

const TasksInputResponseRequestSchema = z.object({
  method: z.literal('tasks/input_response'),
  params: z.object({}).passthrough()
});

type TaskKind = 'basic' | 'multi';

type TaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TaskState {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval: number;
  inputRound: number;
  inputRequests?: Record<string, InputRequest>;
  finalContent?: string;
}

const tasks = new Map<string, TaskState>();

function nowIso(): string {
  return new Date().toISOString();
}

function createTask(kind: TaskKind, ttl?: number): TaskState {
  const now = nowIso();
  return {
    taskId: randomUUID(),
    kind,
    status: 'working',
    ttl: ttl ?? null,
    createdAt: now,
    lastUpdatedAt: now,
    pollInterval: 250,
    inputRound: 0
  };
}

function updateTask(task: TaskState, patch: Partial<TaskState>): TaskState {
  Object.assign(task, patch, { lastUpdatedAt: nowIso() });
  return task;
}

function taskView(task: TaskState) {
  return {
    taskId: task.taskId,
    status: task.status,
    ttl: task.ttl,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    pollInterval: task.pollInterval
  };
}

function ackResult(taskId: string) {
  return {
    acknowledged: true,
    _meta: {
      'io.modelcontextprotocol/related-task': { taskId }
    }
  };
}

function getInputText(inputResponse: unknown, field: string): string {
  const content = (inputResponse as Record<string, unknown> | undefined)
    ?.content as Record<string, unknown> | undefined;
  const value = content?.[field];
  return typeof value === 'string' ? value : 'unknown';
}

class InMemoryEventStore implements EventStore {
  private events: Map<string, { streamId: string; message: string }> =
    new Map();
  private counter = 0;

  async storeEvent(streamId: StreamId, message: string): Promise<EventId> {
    const id = String(++this.counter);
    this.events.set(id, { streamId, message });
    return id;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: string) => Promise<void> }
  ): Promise<string> {
    const startId = parseInt(lastEventId, 10);
    for (const [id, event] of this.events) {
      if (parseInt(id, 10) > startId) {
        await send(id, event.message);
      }
    }
    return '';
  }
}

function createServer(): Server {
  const server = new Server(
    { name: 'sep-2322-mrtr-server', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        prompts: {},
        elicitation: {},
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: {
              call: {}
            }
          }
        }
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'test_input_required_result_elicitation',
        description:
          'Test tool: returns InputRequiredResult with elicitation request',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_sampling',
        description:
          'Test tool: returns InputRequiredResult with sampling request',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_list_roots',
        description:
          'Test tool: returns InputRequiredResult with list roots request',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_request_state',
        description: 'Test tool: returns InputRequiredResult with requestState',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_multiple_inputs',
        description:
          'Test tool: returns InputRequiredResult with multiple input requests',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_multi_round',
        description:
          'Test tool: returns InputRequiredResult across multiple rounds',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_task',
        description: 'Test tool: task-based InputRequiredResult workflow',
        inputSchema: { type: 'object' as const, properties: {} }
      },
      {
        name: 'test_input_required_result_task_multi_input',
        description: 'Test tool: task-based multi-round InputRequiredResult',
        inputSchema: { type: 'object' as const, properties: {} }
      }
    ]
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'test_input_required_result_prompt',
        description:
          'Test prompt: returns InputRequiredResult with elicitation request'
      }
    ]
  }));

  server.setRequestHandler(ExtendedGetPromptRequestSchema, async (request) => {
    const params = request.params as Record<string, unknown>;
    if (params.name !== 'test_input_required_result_prompt') {
      throw new Error(`Unknown prompt: ${params.name}`);
    }

    const inputResponses = params.inputResponses as
      | Record<string, unknown>
      | undefined;

    if (inputResponses?.['user_context']) {
      const context = getInputText(inputResponses['user_context'], 'context');
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt with context: ${context}`
            }
          }
        ]
      };
    }

    return {
      resultType: 'input_required',
      inputRequests: {
        user_context: {
          method: 'elicitation/create',
          params: {
            message: 'What context should the prompt use?',
            requestedSchema: {
              type: 'object',
              properties: { context: { type: 'string' } },
              required: ['context']
            }
          }
        }
      }
    };
  });

  server.setRequestHandler(ExtendedCallToolRequestSchema, async (request) => {
    const params = request.params as Record<string, unknown>;
    const toolName = params.name as string;
    const inputResponses = params.inputResponses as
      | Record<string, unknown>
      | undefined;
    const requestState = params.requestState as string | undefined;

    switch (toolName) {
      case 'test_input_required_result_elicitation': {
        if (inputResponses?.['user_name']) {
          const name = getInputText(inputResponses['user_name'], 'name');
          return {
            content: [{ type: 'text', text: `Hello, ${name}!` }]
          };
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            user_name: {
              method: 'elicitation/create',
              params: {
                message: 'What is your name?',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name']
                }
              }
            }
          }
        };
      }

      case 'test_input_required_result_sampling': {
        if (inputResponses?.['sample_request']) {
          const sample = inputResponses['sample_request'] as Record<
            string,
            unknown
          >;
          const content = sample.content as Record<string, unknown> | undefined;
          return {
            content: [
              {
                type: 'text',
                text: `Sampling result: ${typeof content?.text === 'string' ? content.text : 'no response'}`
              }
            ]
          };
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            sample_request: {
              method: 'sampling/createMessage',
              params: {
                messages: [
                  {
                    role: 'user',
                    content: {
                      type: 'text',
                      text: 'What is the capital of France?'
                    }
                  }
                ],
                maxTokens: 100
              }
            }
          }
        };
      }

      case 'test_input_required_result_list_roots': {
        if (inputResponses?.['roots_request']) {
          const rootsResult = inputResponses['roots_request'] as Record<
            string,
            unknown
          >;
          const roots = Array.isArray(rootsResult.roots)
            ? rootsResult.roots
            : [];
          return {
            content: [{ type: 'text', text: `Found ${roots.length} root(s)` }]
          };
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            roots_request: {
              method: 'roots/list',
              params: {}
            }
          }
        };
      }

      case 'test_input_required_result_request_state': {
        if (requestState && inputResponses?.['confirm']) {
          const state = JSON.parse(requestState) as Record<string, unknown>;
          const ok = (inputResponses['confirm'] as Record<string, unknown>)
            ?.content as Record<string, unknown> | undefined;
          if (state.kind === 'request-state' && ok?.ok === true) {
            return {
              content: [
                { type: 'text', text: 'state-ok: requestState validated' }
              ]
            };
          }
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            confirm: {
              method: 'elicitation/create',
              params: {
                message: 'Please confirm',
                requestedSchema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' } },
                  required: ['ok']
                }
              }
            }
          },
          requestState: JSON.stringify({
            kind: 'request-state',
            nonce: randomUUID()
          })
        };
      }

      case 'test_input_required_result_multiple_inputs': {
        if (
          requestState &&
          inputResponses?.['user_name'] &&
          inputResponses['greeting'] &&
          inputResponses['client_roots']
        ) {
          const state = JSON.parse(requestState) as Record<string, unknown>;
          if (state.kind === 'multiple-inputs') {
            const name = getInputText(inputResponses['user_name'], 'name');
            const greetingContent = (
              inputResponses['greeting'] as Record<string, unknown>
            ).content as Record<string, unknown> | undefined;
            const greeting =
              typeof greetingContent?.text === 'string'
                ? greetingContent.text
                : 'Hello there!';
            const rootsResult = inputResponses['client_roots'] as Record<
              string,
              unknown
            >;
            const roots = Array.isArray(rootsResult.roots)
              ? rootsResult.roots
              : [];
            return {
              content: [
                {
                  type: 'text',
                  text: `Name: ${name}; Greeting: ${greeting}; Roots: ${roots.length}`
                }
              ]
            };
          }
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            user_name: {
              method: 'elicitation/create',
              params: {
                message: 'What is your name?',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name']
                }
              }
            },
            greeting: {
              method: 'sampling/createMessage',
              params: {
                messages: [
                  {
                    role: 'user',
                    content: { type: 'text', text: 'Generate a greeting' }
                  }
                ],
                maxTokens: 50
              }
            },
            client_roots: {
              method: 'roots/list',
              params: {}
            }
          },
          requestState: JSON.stringify({
            kind: 'multiple-inputs',
            nonce: randomUUID()
          })
        };
      }

      case 'test_input_required_result_multi_round': {
        if (!requestState) {
          return {
            resultType: 'input_required',
            inputRequests: {
              step1: {
                method: 'elicitation/create',
                params: {
                  message: 'Step 1: What is your name?',
                  requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                  }
                }
              }
            },
            requestState: JSON.stringify({ round: 1, nonce: randomUUID() })
          };
        }

        const state = JSON.parse(requestState) as Record<string, unknown>;
        if (state.round === 1 && inputResponses?.['step1']) {
          const name = getInputText(inputResponses['step1'], 'name');
          return {
            resultType: 'input_required',
            inputRequests: {
              step2: {
                method: 'elicitation/create',
                params: {
                  message: 'Step 2: What is your favorite color?',
                  requestedSchema: {
                    type: 'object',
                    properties: { color: { type: 'string' } },
                    required: ['color']
                  }
                }
              }
            },
            requestState: JSON.stringify({
              round: 2,
              name,
              nonce: randomUUID()
            })
          };
        }

        if (state.round === 2 && inputResponses?.['step2']) {
          const name = typeof state.name === 'string' ? state.name : 'friend';
          const color = getInputText(inputResponses['step2'], 'color');
          return {
            content: [
              {
                type: 'text',
                text: `Multi-round complete for ${name} who likes ${color}`
              }
            ]
          };
        }

        return {
          resultType: 'input_required',
          inputRequests: {
            step1: {
              method: 'elicitation/create',
              params: {
                message: 'Step 1: What is your name?',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name']
                }
              }
            }
          },
          requestState: JSON.stringify({ round: 1, nonce: randomUUID() })
        };
      }

      case 'test_input_required_result_task': {
        const taskMeta = params.task as Record<string, unknown> | undefined;
        if (!taskMeta) {
          return {
            content: [
              {
                type: 'text',
                text: 'Call with task metadata for task workflow'
              }
            ]
          };
        }

        const task = createTask(
          'basic',
          typeof taskMeta.ttl === 'number' ? taskMeta.ttl : undefined
        );
        task.inputRequests = {
          user_input: {
            method: 'elicitation/create',
            params: {
              message: 'What input should the task use?',
              requestedSchema: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input']
              }
            }
          }
        };
        tasks.set(task.taskId, task);

        setTimeout(() => {
          const current = tasks.get(task.taskId);
          if (current?.status === 'working') {
            updateTask(current, { status: 'input_required' });
          }
        }, 100);

        return { task: taskView(task) };
      }

      case 'test_input_required_result_task_multi_input': {
        const taskMeta = params.task as Record<string, unknown> | undefined;
        if (!taskMeta) {
          return {
            content: [{ type: 'text', text: 'Call with task metadata' }]
          };
        }

        const task = createTask(
          'multi',
          typeof taskMeta.ttl === 'number' ? taskMeta.ttl : undefined
        );
        task.inputRequests = {
          first_input: {
            method: 'elicitation/create',
            params: {
              message: 'First input needed',
              requestedSchema: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input']
              }
            }
          }
        };
        tasks.set(task.taskId, task);

        setTimeout(() => {
          const current = tasks.get(task.taskId);
          if (current?.status === 'working') {
            updateTask(current, { status: 'input_required' });
          }
        }, 100);

        return { task: taskView(task) };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  });

  server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    const taskId = request.params?.taskId as string;
    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    return taskView(task);
  });

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
    const taskId = request.params?.taskId as string;
    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (task.status === 'input_required') {
      return {
        resultType: 'input_required',
        inputRequests: task.inputRequests
      };
    }

    if (task.status === 'completed') {
      return {
        content: [
          {
            type: 'text',
            text: task.finalContent ?? 'Task completed'
          }
        ]
      };
    }

    return { status: task.status };
  });

  server.setRequestHandler(TasksInputResponseRequestSchema, async (request) => {
    const params = request.params as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown> | undefined;
    const relatedTask = meta?.['io.modelcontextprotocol/related-task'] as
      | Record<string, unknown>
      | undefined;
    const taskId = relatedTask?.taskId as string | undefined;
    const inputResponses = params.inputResponses as
      | Record<string, unknown>
      | undefined;

    if (!taskId) {
      throw new Error('Missing related task metadata');
    }

    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    const expectedKeys = Object.keys(task.inputRequests ?? {});
    const providedKeys = Object.keys(inputResponses ?? {});
    const hasAllExpected =
      expectedKeys.length > 0 &&
      expectedKeys.every((key) => providedKeys.includes(key));

    if (!hasAllExpected) {
      updateTask(task, { status: 'input_required' });
      return ackResult(taskId);
    }

    if (task.kind === 'multi' && task.inputRound === 0) {
      task.inputRound = 1;
      updateTask(task, {
        status: 'input_required',
        inputRequests: {
          second_input: {
            method: 'elicitation/create',
            params: {
              message: 'Second input needed',
              requestedSchema: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input']
              }
            }
          }
        }
      });

      return {
        resultType: 'input_required',
        inputRequests: task.inputRequests,
        _meta: {
          'io.modelcontextprotocol/related-task': { taskId }
        }
      };
    }

    if (task.kind === 'basic') {
      const userInput = getInputText(inputResponses?.['user_input'], 'input');
      updateTask(task, {
        status: 'completed',
        finalContent: `Task completed with input: ${userInput}`
      });
    } else {
      const finalInput = getInputText(
        inputResponses?.['second_input'],
        'input'
      );
      updateTask(task, {
        status: 'completed',
        finalContent: `Task completed after second input: ${finalInput}`
      });
    }

    return ackResult(taskId);
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const taskId = request.params?.taskId as string;
    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    updateTask(task, { status: 'cancelled' });
    return { acknowledged: true };
  });

  return server;
}

const app = express();
app.use(express.json());

const sessionTransports: {
  [sessionId: string]: StreamableHTTPServerTransport;
} = {};
const sessionServers: { [sessionId: string]: Server } = {};

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(
      (msg: Record<string, unknown>) => msg.method === 'initialize'
    );
  }
  return (body as Record<string, unknown>)?.method === 'initialize';
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessionTransports[sessionId]) {
    await sessionTransports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const eventStore = new InMemoryEventStore();
    const server = createServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      onsessioninitialized: (sid: string) => {
        sessionTransports[sid] = transport;
        sessionServers[sid] = server;
      }
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        delete sessionTransports[sid];
        delete sessionServers[sid];
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: No valid session' },
    id: null
  });
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && sessionTransports[sessionId]) {
    await sessionTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: No valid session' },
    id: null
  });
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && sessionTransports[sessionId]) {
    await sessionTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: No valid session' },
    id: null
  });
});

const PORT = parseInt(process.env.PORT || '3010', 10);
app.listen(PORT, () => {
  console.log(
    `SEP-2322 MRTR reference server running on http://localhost:${PORT}/mcp`
  );
});
