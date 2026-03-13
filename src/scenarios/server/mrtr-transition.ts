/**
 * SEP-2322: Multi Round-Trip Requests (MRTR) - Ephemeral-to-Persistent Transition Test
 *
 * Tests the transition from an ephemeral workflow to a persistent (task-based)
 * workflow, as described in the SEP section "Interactions Between Ephemeral and
 * Persistent Workflows."
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import {
  createMrtrSession,
  isIncompleteResult,
  mockElicitResponse,
  MRTR_SPEC_REFERENCES,
  MrtrSession
} from './mrtr-helpers';

/**
 * Poll tasks/get until the task reaches the expected status or times out.
 */
async function pollTaskStatus(
  session: MrtrSession,
  taskId: string,
  expectedStatus: string,
  maxAttempts: number = 20,
  intervalMs: number = 250
): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await session.send('tasks/get', { taskId });
    if (response.error) return null;
    const result = response.result;
    if (!result) return null;
    if (result.status === expectedStatus) return result;
    if (
      result.status === 'completed' ||
      result.status === 'failed' ||
      result.status === 'cancelled'
    ) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// ─── D1: Ephemeral-to-Persistent Transition ─────────────────────────────────

export class MrtrEphemeralToPersistentScenario implements ClientScenario {
  name = 'mrtr-ephemeral-to-persistent';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test transition from ephemeral to persistent workflow (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_mrtr_transition\` that demonstrates the ephemeral-to-persistent workflow transition.

**Behavior:**
1. When called with \`task\` metadata in params, the server initially responds with an ephemeral \`IncompleteResult\` (with \`inputRequests\`) rather than creating a task immediately
2. When the client retries the \`tools/call\` with \`inputResponses\` AND \`task\` metadata, the server now creates a persistent task and returns a \`CreateTaskResult\` with a task ID
3. The task can then be managed via the Tasks API

This tests the pattern where a server gathers required input via ephemeral MRTR before committing to task creation, as described in the SEP section "Interactions Between Ephemeral and Persistent Workflows."`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createMrtrSession(serverUrl);

      // Step 1: Call tool with task metadata — server responds ephemerally
      const r1 = await session.send('tools/call', {
        name: 'test_mrtr_transition',
        arguments: {},
        task: { ttl: 30000 }
      });

      const r1Result = r1.result;
      const ephErrors: string[] = [];

      if (r1.error) {
        ephErrors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        ephErrors.push('No result in response');
      } else if (!isIncompleteResult(r1Result)) {
        ephErrors.push(
          'Expected initial IncompleteResult (ephemeral response despite task metadata)'
        );
      } else if (!r1Result.inputRequests) {
        ephErrors.push('IncompleteResult missing inputRequests');
      } else {
        // Verify there is NO task in the response — it should be ephemeral
        if (r1Result.task) {
          ephErrors.push(
            'Ephemeral step should not include task — expected no task creation yet'
          );
        }
      }

      checks.push({
        id: 'mrtr-transition-ephemeral-phase',
        name: 'MRTRTransitionEphemeralPhase',
        description:
          'Server responds with ephemeral IncompleteResult before creating task',
        status: ephErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: ephErrors.length > 0 ? ephErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      if (ephErrors.length > 0 || !isIncompleteResult(r1Result)) return checks;

      // Step 2: Retry with inputResponses + task metadata — server creates task
      const inputKey = Object.keys(
        r1Result.inputRequests as Record<string, unknown>
      )[0];
      const r2 = await session.send('tools/call', {
        name: 'test_mrtr_transition',
        arguments: {},
        inputResponses: {
          [inputKey]: mockElicitResponse({ confirmed: true })
        },
        requestState:
          typeof r1Result.requestState === 'string'
            ? r1Result.requestState
            : undefined,
        task: { ttl: 30000 }
      });

      const r2Result = r2.result;
      const transErrors: string[] = [];
      let taskId: string | undefined;

      if (r2.error) {
        transErrors.push(`JSON-RPC error: ${r2.error.message}`);
      } else if (!r2Result) {
        transErrors.push('No result from retry');
      } else {
        // Should now have a task (persistent workflow)
        const task = r2Result.task as
          | { taskId?: string; status?: string }
          | undefined;
        if (!task?.taskId) {
          transErrors.push(
            'Expected CreateTaskResult with task.taskId after providing input'
          );
        } else {
          taskId = task.taskId;
        }
      }

      checks.push({
        id: 'mrtr-transition-task-created',
        name: 'MRTRTransitionTaskCreated',
        description:
          'Server transitions to persistent workflow and creates task',
        status: transErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          transErrors.length > 0 ? transErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r2Result, taskId }
      });

      if (!taskId) return checks;

      // Step 3: Verify the task is accessible via Tasks API
      const taskState = await pollTaskStatus(
        session,
        taskId,
        'completed',
        40,
        250
      );

      const taskErrors: string[] = [];
      if (!taskState) {
        taskErrors.push('Could not retrieve task state via tasks/get');
      } else if (
        taskState.status !== 'completed' &&
        taskState.status !== 'working'
      ) {
        // Accept working or completed — just verify the task is real
        taskErrors.push(`Unexpected task status: "${taskState.status}"`);
      }

      checks.push({
        id: 'mrtr-transition-task-accessible',
        name: 'MRTRTransitionTaskAccessible',
        description:
          'Created task is accessible via Tasks API after transition',
        status: taskErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: taskErrors.length > 0 ? taskErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { taskState }
      });
    } catch (error) {
      checks.push({
        id: 'mrtr-transition-ephemeral-phase',
        name: 'MRTRTransitionEphemeralPhase',
        description:
          'Server responds with ephemeral IncompleteResult before creating task',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
