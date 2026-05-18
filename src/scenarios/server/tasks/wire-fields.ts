/**
 * SEP-2663 Tasks Extension — wire-format / TTL conformance.
 *
 * Tests the renamed wire fields (ttlMs, pollIntervalMs),
 * the no-early-TTL-expiry rule, and confirms the v1 `related-task` _meta
 * key is absent on tasks/get's inlined result (taskId is at root level
 * already, so the metadata is redundant).
 *
 * Required server fixtures:
 *   - slow_compute — task-supporting, sleeps N seconds
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSource
} from '../../../types';
import {
  TASKS_EXTENSION_ID,
  SEP_2663_REF,
  AnyResult,
  errMsg,
  failureCheck,
  skipCheck,
  waitForTerminal
} from './helpers';

export class TasksWireFieldsScenario implements ClientScenario {
  name = 'tasks-wire-fields';
  source: ScenarioSource = { extensionId: 'io.modelcontextprotocol/tasks' };
  description = `Test SEP-2663 wire-field renames + TTL semantics.

**Server Implementation Requirements:**

**Wire-field renames (SEP-2663):**
- The TTL field is named \`ttlMs\` on the wire (the v1 \`ttl\` key was
  in milliseconds-by-convention; SEP-2663 puts the unit in the field
  name and standardised on the \`Ms\` suffix for all duration fields).
- The poll-interval field is named \`pollIntervalMs\` (v1 used
  \`pollInterval\`).
- A \`CreateTaskResult\` MUST NOT carry the legacy \`ttl\` or
  \`pollInterval\` keys — clients keying off v1 names on a v2 server
  would silently miss the TTL guidance.
- Both \`ttlMs\` and \`pollIntervalMs\` are integer milliseconds.
  Servers MUST NOT emit fractional values.

**TTL non-expiry (SEP-2663):**
- A task MUST remain accessible via \`tasks/get\` for the duration of
  its \`ttlMs\`; a server MUST NOT expire it earlier.

**Inlined-result \`_meta\` (SEP-2663):**
- The v1 \`io.modelcontextprotocol/related-task\` \`_meta\` key MUST NOT
  appear on tasks/get's inlined \`result\` — the \`taskId\` is already
  at the root level of the \`tasks/get\` response, so the metadata is
  redundant.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let client: Client;
    try {
      client = new Client(
        { name: 'mcp-conformance', version: '1.0' },
        {
          capabilities: {
            extensions: { [TASKS_EXTENSION_ID]: {} }
          }
        }
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(serverUrl))
      );
    } catch (error) {
      checks.push({
        id: 'tasks-session-bootstrap',
        name: 'TasksSessionBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2663_REF]
      });
      return checks;
    }

    // Check 1: ttlMs + pollIntervalMs wire shape.
    let createdTaskId: string | undefined;
    {
      const id = 'tasks-wire-field-renames';
      const name = 'TasksWireFieldRenames';
      const description =
        'CreateTaskResult uses ttlMs + pollIntervalMs (integer milliseconds); legacy ttl / pollInterval keys absent';
      try {
        const result = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 1, label: 'wire-fields' }
            }
          },
          AnyResult
        )) as any;
        createdTaskId = result.taskId;
        const errs: string[] = [];
        // ttlMs — required, positive integer milliseconds (or null =
        // unlimited; treat either as well-formed). Legacy `ttl` MUST
        // be absent.
        if (!('ttlMs' in result)) {
          errs.push(
            'CreateTaskResult MUST carry ttlMs (renamed from v1 `ttl`)'
          );
        } else if (
          result.ttlMs !== null &&
          (typeof result.ttlMs !== 'number' ||
            !Number.isInteger(result.ttlMs) ||
            result.ttlMs <= 0)
        ) {
          errs.push(
            `ttlMs MUST be null or a positive integer (milliseconds); got ${JSON.stringify(result.ttlMs)}`
          );
        }
        if ('ttl' in result) {
          errs.push(
            'CreateTaskResult MUST NOT carry the v1 `ttl` key (use ttlMs)'
          );
        }
        // pollIntervalMs — optional. When present it MUST be a positive
        // integer (milliseconds), and the legacy `pollInterval` key MUST
        // NOT appear.
        if (
          result.pollIntervalMs !== undefined &&
          (typeof result.pollIntervalMs !== 'number' ||
            !Number.isInteger(result.pollIntervalMs) ||
            result.pollIntervalMs <= 0)
        ) {
          errs.push(
            `pollIntervalMs MUST be a positive integer when present; got ${JSON.stringify(result.pollIntervalMs)}`
          );
        }
        if ('pollInterval' in result) {
          errs.push(
            'CreateTaskResult MUST NOT carry the v1 `pollInterval` key (use pollIntervalMs)'
          );
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2663_REF],
          details: {
            ttlMs: result.ttlMs,
            pollIntervalMs: result.pollIntervalMs,
            hasLegacyTtl: 'ttl' in result,
            hasLegacyPollInterval: 'pollInterval' in result
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 2: task accessible before TTL elapses.
    {
      const id = 'tasks-no-early-ttl-expiry';
      const name = 'TasksNoEarlyTtlExpiry';
      const description =
        'Task remains accessible via tasks/get for the duration of its ttlMs';
      if (!createdTaskId) {
        checks.push(skipCheck(id, name, description, 'no task created'));
      } else {
        try {
          await waitForTerminal(client, createdTaskId);
          // Sanity probe well before TTL elapses. ttlMs is integer
          // milliseconds and servers typically pick order-of-minutes
          // defaults, so a 500ms wait is comfortably inside any sane TTL.
          await new Promise((r) => setTimeout(r, 500));
          const after = (await client.request(
            {
              method: 'tasks/get',
              params: { taskId: createdTaskId }
            },
            AnyResult
          )) as any;
          const errs: string[] = [];
          if (after.taskId !== createdTaskId) {
            errs.push(
              `task MUST still be accessible before TTL; got taskId=${after.taskId}`
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF]
          });
        } catch (error) {
          checks.push(
            failureCheck(id, name, description, error, [SEP_2663_REF])
          );
        }
      }
    }

    // Check 3: no related-task _meta on inlined result.
    {
      const id = 'tasks-no-related-task-meta-on-inlined-result';
      const name = 'TasksNoRelatedTaskMetaOnInlinedResult';
      const description =
        'tasks/get inlined result MUST NOT include the v1 io.modelcontextprotocol/related-task _meta key (taskId is at the root)';
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 1, label: 'wire-fields-meta' }
            }
          },
          AnyResult
        )) as any;
        const taskId = created.taskId;
        if (!taskId) {
          checks.push(skipCheck(id, name, description, 'no task created'));
        } else {
          const terminal = await waitForTerminal(client, taskId);
          const errs: string[] = [];
          const meta = terminal.result?._meta;
          if (meta && meta['io.modelcontextprotocol/related-task']) {
            errs.push(
              'related-task _meta MUST NOT appear on tasks/get inlined result'
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF],
            details: {
              hasMeta: Boolean(meta),
              hasRelatedTask: Boolean(
                meta?.['io.modelcontextprotocol/related-task']
              )
            }
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    await client.close().catch(() => {});
    return checks;
  }
}
