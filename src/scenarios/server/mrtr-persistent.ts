/**
 * SEP-2322: Multi Round-Trip Requests (MRTR) - Persistent Workflow Tests
 *
 * Tests the persistent (task-based) workflow where servers use Tasks to
 * manage long-running operations that require additional input via
 * tasks/get → input_required → tasks/result → tasks/input_response.
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import {
  createMrtrSession,
  isIncompleteResult,
  isCompleteResult,
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
    // If already completed/failed, stop polling
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

// ─── B1: Basic Persistent Workflow ───────────────────────────────────────────

export class MrtrPersistentBasicScenario implements ClientScenario {
  name = 'mrtr-persistent-basic';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test full persistent MRTR workflow via Tasks API (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_mrtr_persistent\` that supports task-augmented execution.

**Behavior:**
1. When called with \`task\` metadata, return a \`CreateTaskResult\` with \`status: "working"\`
2. After a brief period, set task status to \`"input_required"\`
3. When \`tasks/result\` is called, return an \`IncompleteResult\` with \`inputRequests\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "user_input": {
      "method": "elicitation/create",
      "params": {
        "message": "What input should the task use?",
        "requestedSchema": {
          "type": "object",
          "properties": { "input": { "type": "string" } },
          "required": ["input"]
        }
      }
    }
  }
}
\`\`\`

4. When \`tasks/input_response\` is called with \`inputResponses\`, acknowledge and resume
5. Set task status to \`"completed"\`
6. When \`tasks/result\` is called again, return the final result with tool content`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createMrtrSession(serverUrl);

      // Step 1: Call tool with task metadata
      const r1 = await session.send('tools/call', {
        name: 'test_mrtr_persistent',
        arguments: {},
        task: { ttl: 30000 }
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];
      let taskId: string | undefined;

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else {
        const task = r1Result.task as
          | { taskId?: string; status?: string }
          | undefined;
        if (!task?.taskId) {
          r1Errors.push('Expected CreateTaskResult with task.taskId');
        } else {
          taskId = task.taskId;
          if (task.status !== 'working') {
            r1Errors.push(
              `Expected initial task status "working", got "${task.status}"`
            );
          }
        }
      }

      checks.push({
        id: 'mrtr-persistent-task-created',
        name: 'MRTRPersistentTaskCreated',
        description: 'Server creates task with working status',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result, taskId }
      });

      if (!taskId) return checks;

      // Step 2: Poll tasks/get until input_required
      const taskState = await pollTaskStatus(session, taskId, 'input_required');

      const pollErrors: string[] = [];
      if (!taskState) {
        pollErrors.push(
          'Task did not reach input_required status within timeout'
        );
      } else if (taskState.status !== 'input_required') {
        pollErrors.push(
          `Expected status "input_required", got "${taskState.status}"`
        );
      }

      checks.push({
        id: 'mrtr-persistent-input-required',
        name: 'MRTRPersistentInputRequired',
        description: 'Task reaches input_required status',
        status: pollErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: pollErrors.length > 0 ? pollErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { taskState }
      });

      if (pollErrors.length > 0) return checks;

      // Step 3: Call tasks/result to get inputRequests
      const r3 = await session.send('tasks/result', { taskId });
      const r3Result = r3.result;
      const r3Errors: string[] = [];

      if (r3.error) {
        r3Errors.push(`JSON-RPC error: ${r3.error.message}`);
      } else if (!r3Result) {
        r3Errors.push('No result from tasks/result');
      } else if (!isIncompleteResult(r3Result)) {
        r3Errors.push(
          'Expected IncompleteResult with inputRequests from tasks/result'
        );
      } else if (!r3Result.inputRequests) {
        r3Errors.push(
          'IncompleteResult from tasks/result missing inputRequests'
        );
      }

      checks.push({
        id: 'mrtr-persistent-tasks-result-incomplete',
        name: 'MRTRPersistentTasksResultIncomplete',
        description: 'tasks/result returns IncompleteResult with inputRequests',
        status: r3Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r3Errors.length > 0 ? r3Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r3Result }
      });

      if (r3Errors.length > 0 || !isIncompleteResult(r3Result)) return checks;

      // Step 4: Call tasks/input_response with inputResponses
      const inputKey = Object.keys(r3Result.inputRequests!)[0];
      const r4 = await session.send('tasks/input_response', {
        inputResponses: {
          [inputKey]: mockElicitResponse({ input: 'Hello World!' })
        },
        _meta: {
          'io.modelcontextprotocol/related-task': { taskId }
        }
      });

      const r4Errors: string[] = [];
      if (r4.error) {
        r4Errors.push(`JSON-RPC error: ${r4.error.message}`);
      }

      checks.push({
        id: 'mrtr-persistent-input-response-sent',
        name: 'MRTRPersistentInputResponseSent',
        description: 'tasks/input_response is acknowledged by server',
        status: r4Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r4Errors.length > 0 ? r4Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r4.result }
      });

      // Validate acknowledgment includes task metadata (SHOULD per spec)
      if (r4Errors.length === 0) {
        const r4Result = r4.result;
        const ackErrors: string[] = [];

        if (!r4Result) {
          ackErrors.push('No result from tasks/input_response');
        } else {
          const meta = r4Result._meta as
            | Record<string, unknown>
            | undefined;
          const relatedTask = meta?.[
            'io.modelcontextprotocol/related-task'
          ] as { taskId?: string } | undefined;
          if (!relatedTask?.taskId) {
            ackErrors.push(
              'Acknowledgment missing _meta.io.modelcontextprotocol/related-task.taskId'
            );
          } else if (relatedTask.taskId !== taskId) {
            ackErrors.push(
              `taskId mismatch: expected "${taskId}", got "${relatedTask.taskId}"`
            );
          }
        }

        checks.push({
          id: 'mrtr-persistent-ack-structure',
          name: 'MRTRPersistentAckStructure',
          description:
            'tasks/input_response acknowledgment includes task metadata',
          status: ackErrors.length === 0 ? 'SUCCESS' : 'WARNING',
          timestamp: new Date().toISOString(),
          errorMessage:
            ackErrors.length > 0 ? ackErrors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r4Result }
        });
      }

      if (r4Errors.length > 0) return checks;

      // Step 5: Poll until completed
      const completedState = await pollTaskStatus(session, taskId, 'completed');

      const compErrors: string[] = [];
      if (!completedState) {
        compErrors.push('Task did not reach completed status within timeout');
      } else if (completedState.status !== 'completed') {
        compErrors.push(
          `Expected status "completed", got "${completedState.status}"`
        );
      }

      checks.push({
        id: 'mrtr-persistent-completed',
        name: 'MRTRPersistentCompleted',
        description: 'Task reaches completed status after input_response',
        status: compErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: compErrors.length > 0 ? compErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { taskState: completedState }
      });

      if (compErrors.length > 0) return checks;

      // Step 6: Get final result
      const r6 = await session.send('tasks/result', { taskId });
      const r6Result = r6.result;
      const r6Errors: string[] = [];

      if (r6.error) {
        r6Errors.push(`JSON-RPC error: ${r6.error.message}`);
      } else if (!r6Result) {
        r6Errors.push('No result from final tasks/result');
      } else if (!isCompleteResult(r6Result)) {
        r6Errors.push('Expected complete result from final tasks/result');
      } else if (!r6Result.content) {
        r6Errors.push('Final result missing content');
      }

      checks.push({
        id: 'mrtr-persistent-final-result',
        name: 'MRTRPersistentFinalResult',
        description: 'tasks/result returns complete final result',
        status: r6Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r6Errors.length > 0 ? r6Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r6Result }
      });
    } catch (error) {
      checks.push({
        id: 'mrtr-persistent-task-created',
        name: 'MRTRPersistentTaskCreated',
        description: 'Server creates task with working status',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── B2: Bad Input Response ──────────────────────────────────────────────────

export class MrtrPersistentBadInputResponseScenario implements ClientScenario {
  name = 'mrtr-persistent-bad-input-response';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test error handling when tasks/input_response contains wrong data (SEP-2322).

**Server Implementation Requirements:**

Use the same tool as B1: \`test_mrtr_persistent\`.

**Behavior:** When the client sends \`tasks/input_response\` with incorrect keys, the server SHOULD acknowledge the message but keep the task in \`input_required\` status. The next \`tasks/result\` call should return a new \`inputRequests\` re-requesting the needed information.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createMrtrSession(serverUrl);

      // Create task and wait for input_required
      const r1 = await session.send('tools/call', {
        name: 'test_mrtr_persistent',
        arguments: {},
        task: { ttl: 30000 }
      });

      const task = r1.result?.task as { taskId?: string } | undefined;
      if (!task?.taskId) {
        checks.push({
          id: 'mrtr-persistent-bad-input-prereq',
          name: 'MRTRPersistentBadInputPrereq',
          description: 'Prerequisite: Task creation',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Could not create task',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      const taskId = task.taskId;
      await pollTaskStatus(session, taskId, 'input_required');

      // Get input requests
      const r3 = await session.send('tasks/result', { taskId });
      if (
        r3.error ||
        !r3.result ||
        !isIncompleteResult(r3.result) ||
        !r3.result.inputRequests
      ) {
        checks.push({
          id: 'mrtr-persistent-bad-input-prereq',
          name: 'MRTRPersistentBadInputPrereq',
          description: 'Prerequisite: Get inputRequests',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Could not get inputRequests',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      // Send wrong inputResponses
      const r4 = await session.send('tasks/input_response', {
        inputResponses: {
          wrong_key: mockElicitResponse({ wrong: 'data' })
        },
        _meta: {
          'io.modelcontextprotocol/related-task': { taskId }
        }
      });

      const ackErrors: string[] = [];
      if (r4.error) {
        // Some servers may error; that's acceptable
        ackErrors.push(
          'Server returned error for bad input (acceptable but not preferred)'
        );
      }

      // Check task is still input_required
      const stateAfter = await session.send('tasks/get', { taskId });
      const stillInputRequired = stateAfter.result?.status === 'input_required';

      // Try to get new inputRequests
      let newInputRequests = false;
      if (stillInputRequired) {
        const r5 = await session.send('tasks/result', { taskId });
        if (
          r5.result &&
          isIncompleteResult(r5.result) &&
          r5.result.inputRequests
        ) {
          newInputRequests = true;
        }
      }

      const errors: string[] = [];
      if (!stillInputRequired && ackErrors.length === 0) {
        errors.push(
          'Task should remain in input_required after bad inputResponses'
        );
      }
      if (stillInputRequired && !newInputRequests) {
        errors.push(
          'tasks/result should return new inputRequests after bad input_response'
        );
      }

      checks.push({
        id: 'mrtr-persistent-bad-input-rerequests',
        name: 'MRTRPersistentBadInputRerequests',
        description:
          'Server keeps task in input_required and re-requests after bad inputResponses',
        status:
          errors.length === 0
            ? ackErrors.length === 0
              ? 'SUCCESS'
              : 'WARNING'
            : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          [...errors, ...ackErrors].length > 0
            ? [...errors, ...ackErrors].join('; ')
            : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: {
          stillInputRequired,
          newInputRequests,
          ackResult: r4.result
        }
      });
    } catch (error) {
      checks.push({
        id: 'mrtr-persistent-bad-input-rerequests',
        name: 'MRTRPersistentBadInputRerequests',
        description:
          'Server keeps task in input_required and re-requests after bad inputResponses',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── B4: tasks/input_response returning IncompleteResult ─────────────────────

export class MrtrPersistentInputResponseIncompleteScenario
  implements ClientScenario
{
  name = 'mrtr-persistent-input-response-incomplete';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test that tasks/input_response can itself return an IncompleteResult (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_mrtr_persistent_multi_input\` that supports task-augmented execution and requires TWO rounds of input.

**Behavior:**
1. Create task, transition to \`input_required\`
2. \`tasks/result\` returns IncompleteResult with first \`inputRequests\`
3. \`tasks/input_response\` returns an \`IncompleteResult\` with ADDITIONAL \`inputRequests\`
4. Client sends another \`tasks/input_response\` with the additional responses
5. Task completes

This tests the schema: \`TaskInputResponseResultResponse.result: Result | IncompleteResult\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createMrtrSession(serverUrl);

      // Create task
      const r1 = await session.send('tools/call', {
        name: 'test_mrtr_persistent_multi_input',
        arguments: {},
        task: { ttl: 30000 }
      });

      const task = r1.result?.task as { taskId?: string } | undefined;
      if (!task?.taskId) {
        checks.push({
          id: 'mrtr-persistent-multi-input-prereq',
          name: 'MRTRPersistentMultiInputPrereq',
          description: 'Prerequisite: Task creation',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Could not create task',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      const taskId = task.taskId;
      await pollTaskStatus(session, taskId, 'input_required');

      // Get first inputRequests
      const r3 = await session.send('tasks/result', { taskId });
      if (
        r3.error ||
        !r3.result ||
        !isIncompleteResult(r3.result) ||
        !r3.result.inputRequests
      ) {
        checks.push({
          id: 'mrtr-persistent-multi-input-prereq',
          name: 'MRTRPersistentMultiInputPrereq',
          description: 'Prerequisite: Get first inputRequests',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Could not get inputRequests from tasks/result',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      // Send first input_response — expect IncompleteResult back
      const inputKey1 = Object.keys(r3.result.inputRequests!)[0];
      const r4 = await session.send('tasks/input_response', {
        inputResponses: {
          [inputKey1]: mockElicitResponse({ input: 'step1' })
        },
        _meta: {
          'io.modelcontextprotocol/related-task': { taskId }
        }
      });

      const r4Result = r4.result;
      const r4Errors: string[] = [];

      if (r4.error) {
        r4Errors.push(`JSON-RPC error: ${r4.error.message}`);
      } else if (!r4Result) {
        r4Errors.push('No result from tasks/input_response');
      } else if (!isIncompleteResult(r4Result)) {
        r4Errors.push(
          'Expected IncompleteResult from tasks/input_response (additional input needed)'
        );
      } else if (!r4Result.inputRequests) {
        r4Errors.push(
          'IncompleteResult from tasks/input_response missing inputRequests'
        );
      }

      checks.push({
        id: 'mrtr-persistent-input-response-returns-incomplete',
        name: 'MRTRPersistentInputResponseReturnsIncomplete',
        description:
          'tasks/input_response returns IncompleteResult with additional inputRequests',
        status: r4Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r4Errors.length > 0 ? r4Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r4Result }
      });

      // Send second input_response — expect completion
      if (r4Errors.length === 0 && isIncompleteResult(r4Result)) {
        const inputKey2 = Object.keys(r4Result.inputRequests!)[0];
        const r5 = await session.send('tasks/input_response', {
          inputResponses: {
            [inputKey2]: mockElicitResponse({ input: 'step2' })
          },
          _meta: {
            'io.modelcontextprotocol/related-task': { taskId }
          }
        });

        const r5Ok = !r5.error;

        // Poll for completion
        if (r5Ok) {
          const finalState = await pollTaskStatus(session, taskId, 'completed');

          checks.push({
            id: 'mrtr-persistent-multi-input-completed',
            name: 'MRTRPersistentMultiInputCompleted',
            description: 'Task completes after second input_response',
            status: finalState?.status === 'completed' ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage:
              finalState?.status !== 'completed'
                ? 'Task did not complete after second input_response'
                : undefined,
            specReferences: MRTR_SPEC_REFERENCES,
            details: { taskState: finalState }
          });
        }
      }
    } catch (error) {
      checks.push({
        id: 'mrtr-persistent-input-response-returns-incomplete',
        name: 'MRTRPersistentInputResponseReturnsIncomplete',
        description:
          'tasks/input_response returns IncompleteResult with additional inputRequests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
