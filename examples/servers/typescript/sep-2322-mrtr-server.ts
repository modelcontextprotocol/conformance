#!/usr/bin/env node

/**
 * SEP-2322 MRTR Reference Server (Stateless, SEP-2575 pattern)
 *
 * No session IDs, no initialize handshake. Each request carries _meta with
 * protocolVersion, clientInfo, clientCapabilities. Implements server/discover.
 */

import express from 'express';
import { randomUUID } from 'crypto';

interface InputRequest {
  method: string;
  params?: Record<string, unknown>;
}

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

// --- JSON-RPC dispatch ---

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

const handlers: Record<string, Handler> = {};

handlers['server/discover'] = () => ({
  supportedVersions: ['DRAFT-2026-v1'],
  capabilities: {
    tools: {},
    prompts: {},
    elicitation: {},
    tasks: {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } }
    }
  },
  serverInfo: { name: 'sep-2322-mrtr-server', version: '1.0.0' }
});

handlers['tools/list'] = () => ({
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
});

handlers['prompts/list'] = () => ({
  prompts: [
    {
      name: 'test_input_required_result_prompt',
      description:
        'Test prompt: returns InputRequiredResult with elicitation request'
    }
  ]
});

handlers['prompts/get'] = (params) => {
  if (params.name !== 'test_input_required_result_prompt') {
    throw { code: -32602, message: `Unknown prompt: ${params.name}` };
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
          content: { type: 'text', text: `Prompt with context: ${context}` }
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
};

handlers['tools/call'] = (params) => {
  const toolName = params.name as string;
  const inputResponses = params.inputResponses as
    | Record<string, unknown>
    | undefined;
  const requestState = params.requestState as string | undefined;

  switch (toolName) {
    case 'test_input_required_result_elicitation': {
      if (inputResponses?.['user_name']) {
        const name = getInputText(inputResponses['user_name'], 'name');
        return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
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
        const roots = Array.isArray(rootsResult.roots) ? rootsResult.roots : [];
        return {
          content: [{ type: 'text', text: `Found ${roots.length} root(s)` }]
        };
      }
      return {
        resultType: 'input_required',
        inputRequests: {
          roots_request: { method: 'roots/list', params: {} }
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
          client_roots: { method: 'roots/list', params: {} }
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
          requestState: JSON.stringify({ round: 2, name, nonce: randomUUID() })
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
            { type: 'text', text: 'Call with task metadata for task workflow' }
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
        return { content: [{ type: 'text', text: 'Call with task metadata' }] };
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
      throw { code: -32601, message: `Unknown tool: ${toolName}` };
  }
};

handlers['tasks/get'] = (params) => {
  const taskId = params.taskId as string;
  const task = tasks.get(taskId);
  if (!task) throw { code: -32602, message: `Unknown task: ${taskId}` };
  return taskView(task);
};

handlers['tasks/result'] = (params) => {
  const taskId = params.taskId as string;
  const task = tasks.get(taskId);
  if (!task) throw { code: -32602, message: `Unknown task: ${taskId}` };

  if (task.status === 'input_required') {
    return { resultType: 'input_required', inputRequests: task.inputRequests };
  }
  if (task.status === 'completed') {
    return {
      content: [{ type: 'text', text: task.finalContent ?? 'Task completed' }]
    };
  }
  return { status: task.status };
};

handlers['tasks/input_response'] = (params) => {
  const meta = params._meta as Record<string, unknown> | undefined;
  const relatedTask = meta?.['io.modelcontextprotocol/related-task'] as
    | Record<string, unknown>
    | undefined;
  const taskId = relatedTask?.taskId as string | undefined;
  const inputResponses = params.inputResponses as
    | Record<string, unknown>
    | undefined;

  if (!taskId) throw { code: -32602, message: 'Missing related task metadata' };

  const task = tasks.get(taskId);
  if (!task) throw { code: -32602, message: `Unknown task: ${taskId}` };

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
      _meta: { 'io.modelcontextprotocol/related-task': { taskId } }
    };
  }

  if (task.kind === 'basic') {
    const userInput = getInputText(inputResponses?.['user_input'], 'input');
    updateTask(task, {
      status: 'completed',
      finalContent: `Task completed with input: ${userInput}`
    });
  } else {
    const finalInput = getInputText(inputResponses?.['second_input'], 'input');
    updateTask(task, {
      status: 'completed',
      finalContent: `Task completed after second input: ${finalInput}`
    });
  }

  return ackResult(taskId);
};

handlers['tasks/cancel'] = (params) => {
  const taskId = params.taskId as string;
  const task = tasks.get(taskId);
  if (!task) throw { code: -32602, message: `Unknown task: ${taskId}` };
  updateTask(task, { status: 'cancelled' });
  return { acknowledged: true };
};

// --- Express app ---

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const body = req.body;

  if (!body || !body.jsonrpc || body.jsonrpc !== '2.0') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid JSON-RPC request' },
      id: null
    });
    return;
  }

  const { id, method, params } = body;

  const handler = handlers[method];
  if (!handler) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${method}` },
      id: id ?? null
    });
    return;
  }

  try {
    const result = await handler(params ?? {});
    res.json({ jsonrpc: '2.0', id, result });
  } catch (err: unknown) {
    const rpcErr = err as { code?: number; message?: string };
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: rpcErr.code ?? -32000,
        message: rpcErr.message ?? 'Internal error'
      },
      id: id ?? null
    });
  }
});

const PORT = parseInt(process.env.PORT || '3010', 10);
app.listen(PORT, () => {
  console.log(
    `SEP-2322 MRTR reference server running on http://localhost:${PORT}/mcp`
  );
});
