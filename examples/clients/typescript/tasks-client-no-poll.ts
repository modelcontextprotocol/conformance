#!/usr/bin/env node

/**
 * Deliberately broken SEP-2663 client: it negotiates the Tasks extension and
 * receives CreateTaskResult, but never follows the task with tasks/get.
 */

import { DRAFT_PROTOCOL_VERSION } from '../../../src/types.js';
import { buildStandardHeaders } from '../../../src/connection/stateless.js';
import { runAsCli } from './helpers/cliRunner.js';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
let nextId = 1;

export async function runClient(serverUrl: string): Promise<void> {
  const request = async (
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const meta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'broken-tasks-client',
        version: '1.0.0'
      },
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { [TASKS_EXTENSION_ID]: {} }
      }
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
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result ?? {};
  };

  await request('server/discover');
  await request('tools/list');
  await request('tools/call', {
    name: 'long_running_echo',
    arguments: { text: 'hello' }
  });
  // BUG: ignores CreateTaskResult and exits without tasks/get.
}

runAsCli(runClient, import.meta.url, 'tasks-client-no-poll <server-url>');
