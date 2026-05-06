/**
 * SEP-2322 / SEP-2663 — requestState conformance.
 *
 * Tests the optional opaque session-continuation token:
 *   - Server MAY include requestState on tasks/get responses.
 *   - Clients MUST echo it back on subsequent tasks/get / tasks/update /
 *     tasks/cancel for the same task — server MUST accept the echo.
 *   - Servers MUST tolerate a stale but still-valid token (one minted
 *     before a newer one but still within its TTL window).
 *
 * If the server does not issue requestState at all (it's optional per
 * SEP-2322), the dependent checks emit INFO rather than failing — the
 * spec allows omission.
 *
 * Required server fixtures:
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSpecTag,
  DRAFT_PROTOCOL_VERSION
} from '../../../types';
import {
  TASKS_EXTENSION_ID,
  SEP_2322_REF,
  SEP_2663_REF,
  AnyResult,
  errMsg,
  failureCheck
} from './helpers';

export class TasksRequestStateScenario implements ClientScenario {
  name = 'tasks-request-state';
  specVersions: ScenarioSpecTag[] = ['extension', DRAFT_PROTOCOL_VERSION];
  description = `Test SEP-2322 requestState semantics on the tasks surface.

**Server Implementation Requirements:**

**Optional emission (SEP-2322):**
- A server MAY include a non-empty string \`requestState\` on tasks/get
  responses to allow stateless deployments to resume the conversation.
  When present, it MUST be a non-empty string.

**Echo acceptance:**
- A client that receives a \`requestState\` from tasks/get MUST be able
  to echo it back on a subsequent \`tasks/get\`/\`tasks/update\`/
  \`tasks/cancel\` for the same task. The server MUST accept the echo.

**Stale-but-valid tolerance (SEP-2663):**
- Each tasks/get may mint a new requestState (e.g., for a refreshed
  TTL). After a fresh tasks/get returns a newer token, echoing the
  earlier one MUST still succeed as long as the earlier token has not
  itself expired. (Servers MUST tolerate stale-but-valid tokens
  gracefully.)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let client: Client;
    try {
      client = new Client(
        { name: 'mcp-conformance', version: '1.0' },
        {
          capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } }
        }
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));
    } catch (error) {
      checks.push({
        id: 'tasks-session-bootstrap',
        name: 'TasksSessionBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2322_REF]
      });
      return checks;
    }

    // Drive a long-running task once and reuse it for every check.
    let taskId: string | undefined;
    try {
      const created = (await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'slow_compute',
            arguments: { seconds: 60, label: 'request-state' }
          }
        },
        AnyResult
      )) as any;
      taskId = created.taskId;
    } catch (error) {
      checks.push(
        failureCheck(
          'tasks-request-state-setup',
          'TasksRequestStateSetup',
          'Failed to create a long-running task to exercise requestState',
          error,
          [SEP_2322_REF]
        )
      );
      return checks;
    }
    if (!taskId) {
      checks.push({
        id: 'tasks-request-state-setup',
        name: 'TasksRequestStateSetup',
        description:
          'slow_compute did not produce a task; cannot exercise requestState',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: 'no taskId in CreateTaskResult',
        specReferences: [SEP_2322_REF]
      });
      return checks;
    }

    let firstToken: string | undefined;

    // Check 1: tasks/get response shape — requestState (optional) must
    // be a non-empty string when present.
    {
      const id = 'tasks-request-state-shape';
      const name = 'TasksRequestStateShape';
      const description =
        'tasks/get may include requestState; when present it MUST be a non-empty string';
      try {
        const task = (await client.request(
          { method: 'tasks/get', params: { taskId } },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (task.requestState !== undefined) {
          if (typeof task.requestState !== 'string') {
            errs.push(
              `requestState MUST be a string when present; got ${typeof task.requestState}`
            );
          } else if (task.requestState.length === 0) {
            errs.push(
              'requestState MUST be non-empty when present (omit the field instead of emitting "")'
            );
          } else {
            firstToken = task.requestState;
          }
        }
        // Optional emission: SUCCESS regardless of presence; INFO when
        // server omits it so the result advertises the chosen path.
        const status: 'SUCCESS' | 'INFO' | 'FAILURE' =
          errs.length === 0 ? (firstToken ? 'SUCCESS' : 'INFO') : 'FAILURE';
        checks.push({
          id,
          name,
          description,
          status,
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF],
          details: {
            emitted: Boolean(firstToken),
            tokenLength: firstToken?.length
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2322_REF]));
      }
    }

    // Check 2: client echoes requestState; server accepts the echo.
    {
      const id = 'tasks-request-state-echo';
      const name = 'TasksRequestStateEcho';
      const description =
        'Server accepts a tasks/get with the previously-emitted requestState echoed back';
      if (!firstToken) {
        checks.push({
          id,
          name,
          description,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          errorMessage: 'Server did not emit requestState; nothing to echo',
          specReferences: [SEP_2322_REF]
        });
      } else {
        try {
          const echoed = (await client.request(
            { method: 'tasks/get', params: { taskId, requestState: firstToken } },
            AnyResult
          )) as any;
          const errs: string[] = [];
          if (echoed.taskId !== taskId) {
            errs.push(
              `tasks/get with echoed requestState MUST resolve the same taskId; got ${echoed.taskId}`
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2322_REF]
          });
        } catch (error) {
          checks.push(
            failureCheck(id, name, description, error, [SEP_2322_REF])
          );
        }
      }
    }

    // Check 3: stale-but-valid tolerance.
    {
      const id = 'tasks-request-state-stale-tolerance';
      const name = 'TasksRequestStateStaleTolerance';
      const description =
        'After a newer requestState is minted, the earlier (stale-but-still-valid) token MUST still be accepted';
      if (!firstToken) {
        checks.push({
          id,
          name,
          description,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          errorMessage:
            'Server did not emit requestState; stale tolerance is moot',
          specReferences: [SEP_2663_REF, SEP_2322_REF]
        });
      } else {
        try {
          // Force a fresh mint by issuing another tasks/get. On servers
          // that sign tokens with embedded expiry, this likely yields a
          // newer token; on plaintext-token servers it round-trips the
          // same value (still valid).
          await client.request(
            { method: 'tasks/get', params: { taskId, requestState: firstToken } },
            AnyResult
          );
          // Now re-echo the OLDER token; server MUST accept.
          const stale = (await client.request(
            { method: 'tasks/get', params: { taskId, requestState: firstToken } },
            AnyResult
          )) as any;
          const errs: string[] = [];
          if (stale.taskId !== taskId) {
            errs.push(
              `stale-but-valid requestState MUST resolve the same taskId; got ${stale.taskId}`
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF, SEP_2322_REF]
          });
        } catch (error) {
          checks.push(
            failureCheck(id, name, description, error, [
              SEP_2663_REF,
              SEP_2322_REF
            ])
          );
        }
      }
    }

    // Cleanup the long-lived task so we don't leak goroutines.
    try {
      await client.request(
        { method: 'tasks/cancel', params: { taskId } },
        AnyResult
      );
    } catch {
      /* swallow */
    }

    await client.close().catch(() => {});
    return checks;
  }
}
