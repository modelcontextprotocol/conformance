/**
 * SEP-2322: InputRequiredResult - Ephemeral Workflow Tests
 *
 * Tests the ephemeral (stateless) workflow where servers respond with
 * InputRequiredResult containing inputRequests and/or requestState, and
 * clients retry with inputResponses and echoed requestState.
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  SpecVersion
} from '../../types';
import {
  sendRpc,
  isInputRequiredResult,
  isCompleteResult,
  mockElicitResponse,
  mockSamplingResponse,
  mockListRootsResponse,
  MRTR_SPEC_REFERENCES
} from './input-required-result-helpers';

// ─── A1: Basic Elicitation ────────────────────────────────────────────────────

export class InputRequiredResultBasicElicitationScenario implements ClientScenario {
  name = 'input-required-result-basic-elicitation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test basic ephemeral InputRequiredResult flow with a single elicitation input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_elicitation\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`InputRequiredResult\`:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1: Initial call — expect InputRequiredResult
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_elicitation',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isInputRequiredResult(r1Result)) {
        r1Errors.push(
          'Expected InputRequiredResult but got a complete result. ' +
            'Server should return resultType: "input_required" with inputRequests.'
        );
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('InputRequiredResult missing inputRequests');
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
        id: 'input-required-result-elicitation-incomplete',
        name: 'InputRequiredResultElicitationIncomplete',
        description:
          'Server returns InputRequiredResult with elicitation inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses — expect complete result
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
        const r2 = await sendRpc(serverUrl, 'tools/call', {
          name: 'test_input_required_result_elicitation',
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
          id: 'input-required-result-elicitation-complete',
          name: 'InputRequiredResultElicitationComplete',
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
        id: 'input-required-result-elicitation-incomplete',
        name: 'InputRequiredResultElicitationIncomplete',
        description:
          'Server returns InputRequiredResult with elicitation inputRequest',
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

export class InputRequiredResultBasicSamplingScenario implements ClientScenario {
  name = 'input-required-result-basic-sampling';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test basic ephemeral InputRequiredResult flow with a single sampling input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_sampling\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`InputRequiredResult\`:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1: Initial call
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_sampling',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isInputRequiredResult(r1Result)) {
        r1Errors.push(
          'Expected InputRequiredResult with sampling inputRequest'
        );
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('InputRequiredResult missing inputRequests');
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
        id: 'input-required-result-sampling-incomplete',
        name: 'InputRequiredResultSamplingIncomplete',
        description:
          'Server returns InputRequiredResult with sampling inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await sendRpc(serverUrl, 'tools/call', {
          name: 'test_input_required_result_sampling',
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
          id: 'input-required-result-sampling-complete',
          name: 'InputRequiredResultSamplingComplete',
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
        id: 'input-required-result-sampling-incomplete',
        name: 'InputRequiredResultSamplingIncomplete',
        description:
          'Server returns InputRequiredResult with sampling inputRequest',
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

export class InputRequiredResultBasicListRootsScenario implements ClientScenario {
  name = 'input-required-result-basic-list-roots';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test basic ephemeral InputRequiredResult flow with a single roots/list input request (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_list_roots\` (no arguments required).

**Behavior (Round 1):** When called without \`inputResponses\`, return an \`InputRequiredResult\`:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1: Initial call
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_list_roots',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isInputRequiredResult(r1Result)) {
        r1Errors.push(
          'Expected InputRequiredResult with roots/list inputRequest'
        );
      } else {
        if (!r1Result.inputRequests) {
          r1Errors.push('InputRequiredResult missing inputRequests');
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
        id: 'input-required-result-list-roots-incomplete',
        name: 'InputRequiredResultListRootsIncomplete',
        description:
          'Server returns InputRequiredResult with roots/list inputRequest',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await sendRpc(serverUrl, 'tools/call', {
          name: 'test_input_required_result_list_roots',
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
          id: 'input-required-result-list-roots-complete',
          name: 'InputRequiredResultListRootsComplete',
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
        id: 'input-required-result-list-roots-incomplete',
        name: 'InputRequiredResultListRootsIncomplete',
        description:
          'Server returns InputRequiredResult with roots/list inputRequest',
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

export class InputRequiredResultRequestStateScenario implements ClientScenario {
  name = 'input-required-result-request-state';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test that requestState is correctly round-tripped in ephemeral InputRequiredResult flow (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_request_state\` (no arguments required).

**Behavior (Round 1):** Return an \`InputRequiredResult\` with both \`inputRequests\` and \`requestState\`:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_request_state',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isInputRequiredResult(r1Result)) {
        r1Errors.push('Expected InputRequiredResult');
      } else {
        if (!r1Result.requestState) {
          r1Errors.push('InputRequiredResult missing requestState');
        }
        if (typeof r1Result.requestState !== 'string') {
          r1Errors.push('requestState must be a string');
        }
        if (!r1Result.inputRequests) {
          r1Errors.push('InputRequiredResult missing inputRequests');
        }
      }

      checks.push({
        id: 'input-required-result-request-state-incomplete',
        name: 'InputRequiredResultRequestStateIncomplete',
        description:
          'Server returns InputRequiredResult with both inputRequests and requestState',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses + requestState
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await sendRpc(serverUrl, 'tools/call', {
          name: 'test_input_required_result_request_state',
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
          id: 'input-required-result-request-state-complete',
          name: 'InputRequiredResultRequestStateComplete',
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
        id: 'input-required-result-request-state-incomplete',
        name: 'InputRequiredResultRequestStateIncomplete',
        description:
          'Server returns InputRequiredResult with both inputRequests and requestState',
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

export class InputRequiredResultMultipleInputRequestsScenario implements ClientScenario {
  name = 'input-required-result-multiple-input-requests';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test multiple input requests in a single InputRequiredResult (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_multiple_inputs\` (no arguments required).

**Behavior (Round 1):** Return an \`InputRequiredResult\` with multiple \`inputRequests\` — elicitation, sampling, and roots/list — plus \`requestState\`:

\`\`\`json
{
  "resultType": "input_required",
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
    },
    "client_roots": {
      "method": "roots/list",
      "params": {}
    }
  },
  "requestState": "<opaque-server-state>"
}
\`\`\`

**Behavior (Round 2):** When called with \`inputResponses\` containing ALL keys and the echoed \`requestState\`, return a complete result.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      // Round 1
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_multiple_inputs',
        arguments: {}
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isInputRequiredResult(r1Result)) {
        r1Errors.push('Expected InputRequiredResult');
      } else if (!r1Result.inputRequests) {
        r1Errors.push('InputRequiredResult missing inputRequests');
      } else {
        if (!r1Result.requestState) {
          r1Errors.push('InputRequiredResult missing requestState');
        }

        const keys = Object.keys(r1Result.inputRequests);
        if (keys.length < 3) {
          r1Errors.push(
            `Expected at least 3 inputRequests, got ${keys.length}`
          );
        }

        // Check that required method types are present
        const methods = new Set(
          keys.map((k) => r1Result.inputRequests![k].method)
        );
        if (!methods.has('elicitation/create')) {
          r1Errors.push('Expected an elicitation/create inputRequest');
        }
        if (!methods.has('sampling/createMessage')) {
          r1Errors.push('Expected a sampling/createMessage inputRequest');
        }
        if (!methods.has('roots/list')) {
          r1Errors.push('Expected a roots/list inputRequest');
        }
        if (methods.size < 3) {
          r1Errors.push(
            'Expected inputRequests with different method types (elicitation + sampling + roots/list)'
          );
        }
      }

      checks.push({
        id: 'input-required-result-multiple-inputs-incomplete',
        name: 'InputRequiredResultMultipleInputsIncomplete',
        description:
          'Server returns InputRequiredResult with multiple inputRequests of different types',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Respond to all input requests
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
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

        const r2 = await sendRpc(serverUrl, 'tools/call', {
          name: 'test_input_required_result_multiple_inputs',
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
          id: 'input-required-result-multiple-inputs-complete',
          name: 'InputRequiredResultMultipleInputsComplete',
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
        id: 'input-required-result-multiple-inputs-incomplete',
        name: 'InputRequiredResultMultipleInputsIncomplete',
        description:
          'Server returns InputRequiredResult with multiple inputRequests of different types',
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

export class InputRequiredResultMultiRoundScenario implements ClientScenario {
  name = 'input-required-result-multi-round';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test multi-round ephemeral InputRequiredResult flow with evolving requestState (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_input_required_result_multi_round\` (no arguments required).

**Behavior (Round 1):** Return an \`InputRequiredResult\` with an elicitation request and \`requestState\`:

\`\`\`json
{
  "resultType": "input_required",
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

**Behavior (Round 2):** When called with \`inputResponses\` for step1 + requestState, return ANOTHER \`InputRequiredResult\` with a new elicitation and updated requestState:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_multi_round',
        arguments: {}
      });

      const r1Result = r1.result;
      let round1Complete = false;

      if (
        !r1.error &&
        r1Result &&
        isInputRequiredResult(r1Result) &&
        r1Result.inputRequests &&
        r1Result.requestState
      ) {
        round1Complete = true;
      }

      checks.push({
        id: 'input-required-result-multi-round-r1',
        name: 'InputRequiredResultMultiRoundR1',
        description:
          'Round 1: Server returns InputRequiredResult with requestState',
        status: round1Complete ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: round1Complete
          ? undefined
          : 'Expected InputRequiredResult with inputRequests and requestState',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      if (!round1Complete || !isInputRequiredResult(r1Result)) return checks;

      // Round 2: Retry — expect another InputRequiredResult
      const r1InputKey = Object.keys(r1Result.inputRequests!)[0];
      const r2 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_multi_round',
        arguments: {},
        inputResponses: {
          [r1InputKey]: mockElicitResponse({ name: 'Alice' })
        },
        requestState: r1Result.requestState
      });

      const r2Result = r2.result;
      let round2Complete = false;

      if (
        !r2.error &&
        r2Result &&
        isInputRequiredResult(r2Result) &&
        r2Result.inputRequests &&
        r2Result.requestState
      ) {
        // requestState should have changed
        if (r2Result.requestState !== r1Result.requestState) {
          round2Complete = true;
        }
      }

      checks.push({
        id: 'input-required-result-multi-round-r2',
        name: 'InputRequiredResultMultiRoundR2',
        description:
          'Round 2: Server returns another InputRequiredResult with updated requestState',
        status: round2Complete ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: round2Complete
          ? undefined
          : 'Expected new InputRequiredResult with different requestState',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r2Result }
      });

      if (!round2Complete || !isInputRequiredResult(r2Result)) return checks;

      // Round 3: Final retry — expect complete result
      const r2InputKey = Object.keys(r2Result.inputRequests!)[0];
      const r3 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_multi_round',
        arguments: {},
        inputResponses: {
          [r2InputKey]: mockElicitResponse({ color: 'blue' })
        },
        requestState: r2Result.requestState
      });

      const r3Result = r3.result;
      const round3Complete =
        !r3.error && r3Result != null && isCompleteResult(r3Result);

      checks.push({
        id: 'input-required-result-multi-round-r3',
        name: 'InputRequiredResultMultiRoundR3',
        description: 'Round 3: Server returns complete result',
        status: round3Complete ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: round3Complete
          ? undefined
          : 'Expected complete result after final retry',
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r3Result }
      });
    } catch (error) {
      checks.push({
        id: 'input-required-result-multi-round-r1',
        name: 'InputRequiredResultMultiRoundR1',
        description:
          'Round 1: Server returns InputRequiredResult with requestState',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── A7: Missing Input Response ──────────────────────────────────────────────

export class InputRequiredResultMissingInputResponseScenario implements ClientScenario {
  name = 'input-required-result-missing-input-response';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test error handling when client sends wrong/missing inputResponses (SEP-2322).

**Server Implementation Requirements:**

Use the same tool as A1: \`test_input_required_result_elicitation\`.

**Behavior:** When the client retries with \`inputResponses\` that are missing required keys or contain wrong keys, the server SHOULD respond with a new \`InputRequiredResult\` re-requesting the missing information (NOT a JSON-RPC error).`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      // Round 1: Send wrong inputResponses (wrong key)
      const r1 = await sendRpc(serverUrl, 'tools/call', {
        name: 'test_input_required_result_elicitation',
        arguments: {},
        inputResponses: {
          wrong_key: mockElicitResponse({ data: 'wrong' })
        }
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        // A JSON-RPC error is acceptable but the SEP prefers re-requesting
        r1Errors.push(
          'Server returned JSON-RPC error instead of re-requesting via InputRequiredResult. ' +
            'SEP-2322 recommends servers re-request missing information.'
        );
      } else if (!r1Result) {
        r1Errors.push('No result in response');
      } else if (!isInputRequiredResult(r1Result)) {
        r1Errors.push(
          'Expected InputRequiredResult re-requesting missing information, ' +
            'but got a complete result'
        );
      }

      checks.push({
        id: 'input-required-result-missing-response-rerequests',
        name: 'InputRequiredResultMissingResponseRerequests',
        description:
          'Server re-requests missing inputResponses via new InputRequiredResult',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });
    } catch (error) {
      checks.push({
        id: 'input-required-result-missing-response-rerequests',
        name: 'InputRequiredResultMissingResponseRerequests',
        description:
          'Server re-requests missing inputResponses via new InputRequiredResult',
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

export class InputRequiredResultNonToolRequestScenario implements ClientScenario {
  name = 'input-required-result-non-tool-request';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test InputRequiredResult on a non-tool request (prompts/get) to verify InputRequiredResult is universal (SEP-2322).

**Server Implementation Requirements:**

Implement a prompt named \`test_input_required_result_prompt\` that requires elicitation input.

**Behavior (Round 1):** When \`prompts/get\` is called for \`test_input_required_result_prompt\` without \`inputResponses\`, return an \`InputRequiredResult\`:

\`\`\`json
{
  "resultType": "input_required",
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
      // Round 1
      const r1 = await sendRpc(serverUrl, 'prompts/get', {
        name: 'test_input_required_result_prompt'
      });

      const r1Result = r1.result;
      const r1Errors: string[] = [];

      if (r1.error) {
        r1Errors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result || !isInputRequiredResult(r1Result)) {
        r1Errors.push('Expected InputRequiredResult from prompts/get');
      } else if (!r1Result.inputRequests) {
        r1Errors.push('InputRequiredResult missing inputRequests');
      }

      checks.push({
        id: 'input-required-result-non-tool-incomplete',
        name: 'InputRequiredResultNonToolIncomplete',
        description:
          'prompts/get returns InputRequiredResult with inputRequests',
        status: r1Errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: r1Errors.length > 0 ? r1Errors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Round 2: Retry with inputResponses
      if (r1Errors.length === 0 && isInputRequiredResult(r1Result)) {
        const inputKey = Object.keys(r1Result.inputRequests!)[0];
        const r2 = await sendRpc(serverUrl, 'prompts/get', {
          name: 'test_input_required_result_prompt',
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
          id: 'input-required-result-non-tool-complete',
          name: 'InputRequiredResultNonToolComplete',
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
        id: 'input-required-result-non-tool-incomplete',
        name: 'InputRequiredResultNonToolIncomplete',
        description:
          'prompts/get returns InputRequiredResult with inputRequests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
