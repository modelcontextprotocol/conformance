#!/usr/bin/env node

/**
 * Deliberately broken SEP-2663 client: it declares the Tasks extension on the
 * task-producing tools/call, then omits it from the tasks/get request.
 */

import { DRAFT_PROTOCOL_VERSION } from '../../../src/types.js';
import { buildStandardHeaders } from '../../../src/connection/stateless.js';
import { runAsCli } from './helpers/cliRunner.js';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
let nextId = 1;

export async function runClient(serverUrl: string): Promise<void> {
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    declareTasks = true
  ): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const extensions = declareTasks ? { [TASKS_EXTENSION_ID]: {} } : {};
    const meta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'broken-tasks-client',
        version: '1.0.0'
      },
      'io.modelcontextprotocol/clientCapabilities': { extensions }
    };
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: buildStandardHeaders(method, params, {
        specVersion: DRAFT_PROTOCOL_VERSION
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: { ...params, _meta: meta }
      })
    });
    const body = (await response.json()) as {
      result?: Record<string, unknown>;
    };
    return body.result ?? {};
  };

  await request('server/discover');
  await request('tools/list');
  const result = await request('tools/call', {
    name: 'long_running_echo',
    arguments: { text: 'hello' }
  });
  const taskId = result.taskId;
  if (typeof taskId !== 'string') {
    throw new Error('CreateTaskResult did not contain a taskId');
  }

  // BUG: tasks/get omits the per-request Tasks extension declaration.
  await request('tasks/get', { taskId }, false);
}

runAsCli(
  runClient,
  import.meta.url,
  'tasks-client-missing-get-capability <server-url>'
);
