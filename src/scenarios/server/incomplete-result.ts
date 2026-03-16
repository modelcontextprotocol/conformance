/**
 * SEP-2322: IncompleteResult - Ephemeral Workflow Tests
 *
 * Tests the ephemeral (stateless) workflow where servers respond with
 * IncompleteResult containing inputRequests and/or requestState, and
 * clients retry with inputResponses and echoed requestState.
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import {
  createIncompleteResultSession,
  isIncompleteResult,
  isCompleteResult,
  mockElicitResponse,
  mockSamplingResponse,
  mockListRootsResponse,
  MRTR_SPEC_REFERENCES
} from './incomplete-result-helpers';

// ─── A1: Basic Elicitation ────────────────────────────────────────────────────

export class IncompleteResultBasicElicitationScenario
  implements ClientScenario
{
  name = 'incomplete-result-basic-elicitation';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test basic ephemeral IncompleteResult flow with a single elicitation input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_tool_with_elicitation\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`IncompleteResult\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "user_name": {
      "method": "elicitation/create",
      "params": {
        "message": "What is your name?",
        "requestedSchema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" }
          },
          "required": ["name"]
        }
      }
    }
  }
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` containing the key \`"user_name"\`, return a complete result:

\`\`\`json
{
  "content": [{ "type": "text", "text": "Hello, <name>!" }]
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1: Initial call — expect IncompleteResult
      const r1 = await session.send('tools/call', {
        name: 'test_tool_with_elicitation',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isIncompleteResult(r1Result)) {
        r1Errors.push(
          'Expected IncompleteResult but got a complete result. ' +
            'Server should return result_type: "incomplete" with inputRequests.'
        );
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('IncompleteResult missing inputRequests');
        } else if (!r1Result.inputRequests['user_name']) {
          r1Errors.push('inputRequests missing expected key "user_name"');
        } else {
          const req = r1Result.inputRequests['user_name'];
          if (req.method !== 'elicitation/create') {
            r1Errors.push(
              `Expected method "elicitation/create", got "${req.method}"`
            );
          }
        }
      }

      checks.push({
        id: 'incomplete-result-elicitation-incomplete',
        name: 'IncompleteResultElicitationIncomplete',
        description:
          'Server returns IncompleteResult with elicitation inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses — expect complete result
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_elicitation',
          arguments: {},
          inputResponses: {
            user_name: mockElicitResponse({ name: 'Alice' })
          },
          ...(r1Result.requestState !== undefined
            ? { requestState: r1Result.requestState }
            : {})
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push(
            'Expected complete result after retry with inputResponses'
          );
        } else {
          const content = r2Result.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          if (!content || !Array.isArray(content) || content.length === 0) {
            r2Errors.push('Complete result missing content array');
          }
        }

        checks.push({
          id: 'incomplete-result-elicitation-complete',
          name: 'IncompleteResultElicitationComplete',
          description:
            'Server returns complete result after retry with inputResponses',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-elicitation-incomplete',
        name: 'IncompleteResultElicitationIncomplete',
        description:
          'Server returns IncompleteResult with elicitation inputRequest',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A2: Basic Sampling ──────────────────────────────────────────────────────

export class IncompleteResultBasicSamplingScenario implements ClientScenario {
  name = 'incomplete-result-basic-sampling';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test basic ephemeral IncompleteResult flow with a single sampling input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_sampling\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`IncompleteResult\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "capital_question": {
      "method": "sampling/createMessage",
      "params": {
        "messages": [{
          "role": "user",
          "content": { "type": "text", "text": "What is the capital of France?" }
        }],
        "maxTokens": 100
      }
    }
  }
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` containing the key \`"capital_question"\`, return a complete result with the sampling response text.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1: Initial call
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_sampling',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult with sampling inputRequest');
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('IncompleteResult missing inputRequests');
        } else {
          const key = Object.keys(r1Result.inputRequests)[0];
          if (!key) {
            r1Errors.push('inputRequests map is empty');
          } else {
            const req = r1Result.inputRequests[key];
            if (req.method !== 'sampling/createMessage') {
              r1Errors.push(
                `Expected method "sampling/createMessage", got "${req.method}"`
              );
            }
          }
        }
      }

      checks.push({
        id: 'incomplete-result-sampling-incomplete',
        name: 'IncompleteResultSamplingIncomplete',
        description:
          'Server returns IncompleteResult with sampling inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_sampling',
          arguments: {},
          inputResponses: {
            [inputKey]: mockSamplingResponse('The capital of France is Paris.')
          },
          ...(r1Result.requestState !== undefined
            ? { requestState: r1Result.requestState }
            : {})
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push(
            'Expected complete result after retry with sampling response'
          );
        }

        checks.push({
          id: 'incomplete-result-sampling-complete',
          name: 'IncompleteResultSamplingComplete',
          description:
            'Server returns complete result after retry with sampling response',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-sampling-incomplete',
        name: 'IncompleteResultSamplingIncomplete',
        description:
          'Server returns IncompleteResult with sampling inputRequest',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A3: Basic ListRoots ─────────────────────────────────────────────────────

export class IncompleteResultBasicListRootsScenario implements ClientScenario {
  name = 'incomplete-result-basic-list-roots';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test basic ephemeral IncompleteResult flow with a single roots/list input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_list_roots\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`IncompleteResult\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "client_roots": {
      "method": "roots/list",
      "params": {}
    }
  }
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` containing the key \`"client_roots"\` (a ListRootsResult with a \`roots\` array), return a complete result that references the provided roots.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1: Initial call
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_list_roots',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult with roots/list inputRequest');
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('IncompleteResult missing inputRequests');
        } else {
          const key = Object.keys(r1Result.inputRequests)[0];
          if (!key) {
            r1Errors.push('inputRequests map is empty');
          } else {
            const req = r1Result.inputRequests[key];
            if (req.method !== 'roots/list') {
              r1Errors.push(
                `Expected method "roots/list", got "${req.method}"`
              );
            }
          }
        }
      }

      checks.push({
        id: 'incomplete-result-list-roots-incomplete',
        name: 'IncompleteResultListRootsIncomplete',
        description:
          'Server returns IncompleteResult with roots/list inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_list_roots',
          arguments: {},
          inputResponses: {
            [inputKey]: mockListRootsResponse()
          },
          ...(r1Result.requestState !== undefined
            ? { requestState: r1Result.requestState }
            : {})
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push(
            'Expected complete result after retry with roots response'
          );
        }

        checks.push({
          id: 'incomplete-result-list-roots-complete',
          name: 'IncompleteResultListRootsComplete',
          description:
            'Server returns complete result after retry with roots response',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-list-roots-incomplete',
        name: 'IncompleteResultListRootsIncomplete',
        description:
          'Server returns IncompleteResult with roots/list inputRequest',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A4: Request State ──────────────────────────────────────────────────────

export class IncompleteResultRequestStateScenario implements ClientScenario {
  name = 'incomplete-result-request-state';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test that requestState is correctly round-tripped in ephemeral IncompleteResult flow (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_request_state\` (no arguments required).

**Behavior (Round 1):** Return an \`IncompleteResult\` with both \`inputRequests\` and \`requestState\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "confirm": {
      "method": "elicitation/create",
      "params": {
        "message": "Please confirm",
        "requestedSchema": {
          "type": "object",
          "properties": { "ok": { "type": "boolean" } },
          "required": ["ok"]
        }
      }
    }
  },
  "requestState": "<opaque-server-state>"
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` AND the echoed \`requestState\`, validate the state and return a complete result. The text content MUST include the word "state-ok" to confirm the server received and validated the requestState.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_request_state',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult');
      } else {
        if (!r1Result.requestState) {
          r1Errors.push('IncompleteResult missing requestState');
        }
        if (typeof r1Result.requestState !== 'string') {
          r1Errors.push('requestState must be a string');
        }
        if (!r1Result.inputRequests) {
          r1Errors.push('IncompleteResult missing inputRequests');
        }
      }

      checks.push({
        id: 'incomplete-result-request-state-incomplete',
        name: 'IncompleteResultRequestStateIncomplete',
        description:
          'Server returns IncompleteResult with both inputRequests and requestState',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses + requestState
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_request_state',
          arguments: {},
          inputResponses: {
            [inputKey]: mockElicitResponse({ ok: true })
          },
          requestState: r1Result.requestState
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push(
            'Expected complete result after retry with requestState'
          );
        } else {
          // Check that server confirmed it received the state
          const content = r2Result.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          const text = content?.find((c) => c.type === 'text')?.text ?? '';
          if (!text.includes('state-ok')) {
            r2Errors.push(
              'Server response text should include "state-ok" to confirm requestState was validated'
            );
          }
        }

        checks.push({
          id: 'incomplete-result-request-state-complete',
          name: 'IncompleteResultRequestStateComplete',
          description:
            'Server validates echoed requestState and returns complete result',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-request-state-incomplete',
        name: 'IncompleteResultRequestStateIncomplete',
        description:
          'Server returns IncompleteResult with both inputRequests and requestState',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A5: Multiple Input Requests ─────────────────────────────────────────────

export class IncompleteResultMultipleInputRequestsScenario
  implements ClientScenario
{
  name = 'incomplete-result-multiple-input-requests';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test multiple input requests in a single IncompleteResult (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_multiple_inputs\` (no arguments required).

**Behavior (Round 1):** Return an \`IncompleteResult\` with multiple \`inputRequests\` — at least one elicitation AND one sampling:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "user_name": {
      "method": "elicitation/create",
      "params": {
        "message": "What is your name?",
        "requestedSchema": {
          "type": "object",
          "properties": { "name": { "type": "string" } },
          "required": ["name"]
        }
      }
    },
    "greeting": {
      "method": "sampling/createMessage",
      "params": {
        "messages": [{ "role": "user", "content": { "type": "text", "text": "Generate a greeting" } }],
        "maxTokens": 50
      }
    }
  }
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` containing ALL keys, return a complete result.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_multiple_inputs',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult');
      } else if (!r1Result.inputRequests) {
        r1Errors.push('IncompleteResult missing inputRequests');
      } else {
        const keys = Object.keys(r1Result.inputRequests);
        if (keys.length < 2) {
          r1Errors.push(
            `Expected at least 2 inputRequests, got ${keys.length}`
          );
        }
        // Check that we have different method types
        const methods = new Set(
          keys.map((k) => r1Result.inputRequests![k].method)
        );
        if (methods.size < 2) {
          r1Errors.push(
            'Expected inputRequests with different method types (e.g., elicitation + sampling)'
          );
        }
      }

      checks.push({
        id: 'incomplete-result-multiple-inputs-incomplete',
        name: 'IncompleteResultMultipleInputsIncomplete',
        description:
          'Server returns IncompleteResult with multiple inputRequests of different types',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Respond to all input requests
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const inputResponses: Record<string, unknown> = {};
        for (const [key, req] of Object.entries(r1Result.inputRequests!)) {
          if (req.method === 'elicitation/create') {
            inputResponses[key] = mockElicitResponse({ name: 'Alice' });
          } else if (req.method === 'sampling/createMessage') {
            inputResponses[key] = mockSamplingResponse('Hello there!');
          } else if (req.method === 'roots/list') {
            inputResponses[key] = mockListRootsResponse();
          }
        }

        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_multiple_inputs',
          arguments: {},
          inputResponses,
          ...(r1Result.requestState !== undefined
            ? { requestState: r1Result.requestState }
            : {})
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push(
            'Expected complete result after providing all inputResponses'
          );
        }

        checks.push({
          id: 'incomplete-result-multiple-inputs-complete',
          name: 'IncompleteResultMultipleInputsComplete',
          description:
            'Server returns complete result after all inputResponses are provided',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-multiple-inputs-incomplete',
        name: 'IncompleteResultMultipleInputsIncomplete',
        description:
          'Server returns IncompleteResult with multiple inputRequests of different types',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A6: Multi-Round ─────────────────────────────────────────────────────────

export class IncompleteResultMultiRoundScenario implements ClientScenario {
  name = 'incomplete-result-multi-round';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test multi-round ephemeral IncompleteResult flow with evolving requestState (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_multi_round\` (no arguments required).

**Behavior (Round 1):** Return an \`IncompleteResult\` with an elicitation request and \`requestState\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "step1": {
      "method": "elicitation/create",
      "params": {
        "message": "Step 1: What is your name?",
        "requestedSchema": {
          "type": "object",
          "properties": { "name": { "type": "string" } },
          "required": ["name"]
        }
      }
    }
  },
  "requestState": "<state-round-1>"
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` for step1 + requestState, return ANOTHER \`IncompleteResult\` with a new elicitation and updated requestState:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "step2": {
      "method": "elicitation/create",
      "params": {
        "message": "Step 2: What is your favorite color?",
        "requestedSchema": {
          "type": "object",
          "properties": { "color": { "type": "string" } },
          "required": ["color"]
        }
      }
    }
  },
  "requestState": "<state-round-2>"
}
\`\`\`

**Behavior (Round 3):** When called with \`inputResponses\` for step2 + updated requestState, return a complete result.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_multi_round',
        arguments: {}
      });

      const r1Result = r1.result;
      let r1Ok = false;

      if (
        !r1.error &&
        r1Result &&
        isIncompleteResult(r1Result) &&
        r1Result.inputRequests &&
        r1Result.requestState
      ) {
        r1Ok = true;
      }

      checks.push({
        id: 'incomplete-result-multi-round-r1',
        name: 'IncompleteResultMultiRoundR1',
        description:
          'Round 1: Server returns IncompleteResult with requestState',
        status: r1Ok ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Ok
          ? undefined
          : 'Expected IncompleteResult with inputRequests and requestState',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      if (!r1Ok || !isIncompleteResult(r1Result)) return checks;

      // Round 2: Retry — expect another IncompleteResult
      const r1InputKey = Object.keys(r1Result.inputRequests!)[0];
      const r2 = await session.send('tools/call', {
        name: 'test_incomplete_result_multi_round',
        arguments: {},
        inputResponses: {
          [r1InputKey]: mockElicitResponse({ name: 'Alice' })
        },
        requestState: r1Result.requestState
      });

      const r2Result = r2.result;
      let r2Ok = false;

      if (
        !r2.error &&
        r2Result &&
        isIncompleteResult(r2Result) &&
        r2Result.inputRequests &&
        r2Result.requestState
      ) {
        // requestState should have changed
        if (r2Result.requestState !== r1Result.requestState) {
          r2Ok = true;
        }
      }

      checks.push({
        id: 'incomplete-result-multi-round-r2',
        name: 'IncompleteResultMultiRoundR2',
        description:
          'Round 2: Server returns another IncompleteResult with updated requestState',
        status: r2Ok ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r2Ok
          ? undefined
          : 'Expected new IncompleteResult with different requestState',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r2Result }
      });

      if (!r2Ok || !isIncompleteResult(r2Result)) return checks;

      // Round 3: Final retry — expect complete result
      const r2InputKey = Object.keys(r2Result.inputRequests!)[0];
      const r3 = await session.send('tools/call', {
        name: 'test_incomplete_result_multi_round',
        arguments: {},
        inputResponses: {
          [r2InputKey]: mockElicitResponse({ color: 'blue' })
        },
        requestState: r2Result.requestState
      });

      const r3Result = r3.result;
      const r3Ok = !r3.error && r3Result != null && isCompleteResult(r3Result);

      checks.push({
        id: 'incomplete-result-multi-round-r3',
        name: 'IncompleteResultMultiRoundR3',
        description: 'Round 3: Server returns complete result',
        status: r3Ok ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r3Ok
          ? undefined
          : 'Expected complete result after final retry',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r3Result }
      });
    } catch (error) {
      checks.push({
        id: 'incomplete-result-multi-round-r1',
        name: 'IncompleteResultMultiRoundR1',
        description:
          'Round 1: Server returns IncompleteResult with requestState',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A7: Request State Only ──────────────────────────────────

export class IncompleteResultRequestStateOnlyScenario
  implements ClientScenario
{
  name = 'incomplete-result-request-state-only';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test IncompleteResult with requestState only — no inputRequests (load-shedding use case, SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_state_only\` (no arguments required).

**Behavior (Round 1):** Return an \`IncompleteResult\` with \`requestState\` but NO \`inputRequests\`:

\`\`\`json
{
  "result_type": "incomplete",
  "requestState": "<accumulated-computation-state>"
}
\`\`\`

**Behavior (Round 2):** When called with the echoed \`requestState\` (no \`inputResponses\`), return a complete result.

This simulates load shedding where the server transfers accumulated computation state to be resumed by another instance.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1: Expect IncompleteResult with requestState only
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_state_only',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult');
      } else {
        if (!r1Result.requestState) {
          r1Errors.push('IncompleteResult missing requestState');
        }
        if (r1Result.inputRequests) {
          r1Errors.push(
            'Load-shedding IncompleteResult should NOT have inputRequests'
          );
        }
      }

      checks.push({
        id: 'incomplete-result-state-only-incomplete',
        name: 'IncompleteResultStateOnlyIncomplete',
        description:
          'Server returns IncompleteResult with requestState only (no inputRequests)',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with requestState only
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_state_only',
          arguments: {},
          requestState: r1Result.requestState
        });

        const r2Result = r2.result;
        const r2Ok =
          !r2.error && r2Result != null && isCompleteResult(r2Result);

        checks.push({
          id: 'incomplete-result-state-only-complete',
          name: 'IncompleteResultStateOnlyComplete',
          description:
            'Server completes after receiving echoed requestState (no inputResponses needed)',
          status: r2Ok ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Ok
            ? undefined
            : 'Expected complete result after retry with requestState',
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-state-only-incomplete',
        name: 'IncompleteResultStateOnlyIncomplete',
        description:
          'Server returns IncompleteResult with requestState only (no inputRequests)',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A8: Missing Input Response ──────────────────────────────────────────────

export class IncompleteResultMissingInputResponseScenario
  implements ClientScenario
{
  name = 'incomplete-result-missing-input-response';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test error handling when client sends wrong/missing inputResponses (SEP-2322).

**Server Implementation Requirements:**

Use the same tool as A1: \`test_incomplete_result_elicitation\`.

**Behavior:** When the client retries with \`inputResponses\` that are missing required keys or contain wrong keys, the server SHOULD respond with a new \`IncompleteResult\` re-requesting the missing information (NOT a JSON-RPC error).`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1: Get the initial IncompleteResult
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_elicitation',
        arguments: {}
      });

      if (
        r1.error ||
        !r1.result ||
        !isIncompleteResult(r1.result) ||
        !r1.result.inputRequests
      ) {
        checks.push({
          id: 'incomplete-result-missing-response-prereq',
          name: 'IncompleteResultMissingResponsePrereq',
          description: 'Prerequisite: Server returns IncompleteResult',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            'Could not get initial IncompleteResult to test error handling',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      // Round 2: Send wrong inputResponses (wrong key)
      const r2 = await session.send('tools/call', {
        name: 'test_incomplete_result_elicitation',
        arguments: {},
        inputResponses: {
          wrong_key: mockElicitResponse({ data: 'wrong' })
        },
        ...(r1.result.requestState !== undefined
          ? { requestState: r1.result.requestState }
          : {})
      });

      const r2Result = r2.result;
      const r2Errors: string[] = [];

      if (r2.error) {
        // A JSON-RPC error is acceptable but the SEP prefers re-requesting
        r2Errors.push(
          'Server returned JSON-RPC error instead of re-requesting via IncompleteResult. ' +
            'SEP-2322 recommends servers re-request missing information.'
        );
      } else if (!r2Result) {
        r2Errors.push('No result in response');
      } else if (!isIncompleteResult(r2Result)) {
        r2Errors.push(
          'Expected IncompleteResult re-requesting missing information, ' +
            'but got a complete result'
        );
      }

      checks.push({
        id: 'incomplete-result-missing-response-rerequests',
        name: 'IncompleteResultMissingResponseRerequests',
        description:
          'Server re-requests missing inputResponses via new IncompleteResult',
        status: r2Errors.length === 0 ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r2Result }
      });
    } catch (error) {
      checks.push({
        id: 'incomplete-result-missing-response-rerequests',
        name: 'IncompleteResultMissingResponseRerequests',
        description:
          'Server re-requests missing inputResponses via new IncompleteResult',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A9: Non-Tool Request (prompts/get) ──────────────────────────────────────

export class IncompleteResultNonToolRequestScenario implements ClientScenario {
  name = 'incomplete-result-non-tool-request';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test IncompleteResult on a non-tool request (prompts/get) to verify IncompleteResult is universal (SEP-2322).

**Server Implementation Requirements:**

Implement a prompt named \`test_incomplete_result_prompt\` that requires elicitation input.

**Behavior (Round 1):** When \`prompts/get\` is called for \`test_incomplete_result_prompt\` without \`inputResponses\`, return an \`IncompleteResult\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "user_context": {
      "method": "elicitation/create",
      "params": {
        "message": "What context should the prompt use?",
        "requestedSchema": {
          "type": "object",
          "properties": { "context": { "type": "string" } },
          "required": ["context"]
        }
      }
    }
  }
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\`, return a complete \`GetPromptResult\`.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Round 1
      const r1 = await session.send('prompts/get', {
        name: 'test_incomplete_result_prompt'
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isIncompleteResult(r1Result)) {
        r1Errors.push('Expected IncompleteResult from prompts/get');
      } else if (!r1Result.inputRequests) {
        r1Errors.push('IncompleteResult missing inputRequests');
      }

      checks.push({
        id: 'incomplete-result-non-tool-incomplete',
        name: 'IncompleteResultNonToolIncomplete',
        description: 'prompts/get returns IncompleteResult with inputRequests',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isIncompleteResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await session.send('prompts/get', {
          name: 'test_incomplete_result_prompt',
          inputResponses: {
            [inputKey]: mockElicitResponse({ context: 'test context' })
          },
          ...(r1Result.requestState !== undefined
            ? { requestState: r1Result.requestState }
            : {})
        });

        const r2Result = r2.result;
        const r2Errors: string[] = [];

        if (r2.error) {
          r2Errors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          r2Errors.push('No result in response');
        } else if (!isCompleteResult(r2Result)) {
          r2Errors.push('Expected complete GetPromptResult after retry');
        } else if (!r2Result.messages) {
          r2Errors.push(
            'Complete result missing messages (expected GetPromptResult)'
          );
        }

        checks.push({
          id: 'incomplete-result-non-tool-complete',
          name: 'IncompleteResultNonToolComplete',
          description:
            'prompts/get returns complete GetPromptResult after retry with inputResponses',
          status: r2Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r2Errors.length > 0 ? r2Errors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-non-tool-incomplete',
        name: 'IncompleteResultNonToolIncomplete',
        description: 'prompts/get returns IncompleteResult with inputRequests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
