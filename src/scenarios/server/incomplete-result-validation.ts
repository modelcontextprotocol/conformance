/**
 * SEP-2322: IncompleteResult - Schema/Structure Validation Tests
 *
 * Tests that validate the structure and correctness of IncompleteResult protocol
 * messages, including IncompleteResult format, InputRequest types, and
 * result_type field behavior.
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import {
  createIncompleteResultSession,
  isIncompleteResult,
  mockElicitResponse,
  mockSamplingResponse,
  mockListRootsResponse,
  MRTR_SPEC_REFERENCES
} from './incomplete-result-helpers';

// ─── C1: IncompleteResult Structure Validation ──────────────────────────────

export class IncompleteResultStructureScenario implements ClientScenario {
  name = 'incomplete-result-structure';
  specVersions: SpecVersion[] = ['draft'];
  description = `Validate the IncompleteResult structure conforms to the schema (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_validate_structure\` that returns an \`IncompleteResult\` with well-formed fields.

**Behavior:**
1. When called, return an \`IncompleteResult\` with both \`inputRequests\` and \`requestState\`:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "req1": {
      "method": "elicitation/create",
      "params": {
        "message": "Validation test",
        "requestedSchema": {
          "type": "object",
          "properties": { "value": { "type": "string" } },
          "required": ["value"]
        }
      }
    }
  },
  "requestState": "validation-state-token"
}
\`\`\`

2. When retried with correct \`inputResponses\` and \`requestState\`, return a final result with \`result_type\` absent (testing default behavior).

**Validation checks:**
- \`result_type\` is exactly \`"incomplete"\` (not any other string)
- \`inputRequests\` is present and is a map (object)
- Each \`inputRequests\` value has \`method\` and \`params\`
- \`requestState\` is a string
- Final result has \`result_type\` absent (backward compat for "complete")`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      // Get IncompleteResult
      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_validate_structure',
        arguments: {}
      });

      const r1Result = r1.result;
      const structureErrors: string[] = [];

      if (r1.error) {
        structureErrors.push(`JSON-RPC error: ${r1.error.message}`);
      } else if (!r1Result) {
        structureErrors.push('No result in response');
      } else {
        // Check result_type is exactly "incomplete"
        if (r1Result.result_type !== 'incomplete') {
          structureErrors.push(
            `result_type should be "incomplete", got "${r1Result.result_type}"`
          );
        }

        // Check inputRequests is present and is an object
        if (!r1Result.inputRequests) {
          structureErrors.push('inputRequests is missing');
        } else if (
          typeof r1Result.inputRequests !== 'object' ||
          Array.isArray(r1Result.inputRequests)
        ) {
          structureErrors.push(
            'inputRequests should be an object (map), not an array'
          );
        } else {
          // Validate each input request has method and params
          const requests = r1Result.inputRequests as Record<
            string,
            Record<string, unknown>
          >;
          for (const [key, value] of Object.entries(requests)) {
            if (!value.method || typeof value.method !== 'string') {
              structureErrors.push(
                `inputRequests["${key}"] missing valid "method" field`
              );
            }
            if (!value.params || typeof value.params !== 'object') {
              structureErrors.push(
                `inputRequests["${key}"] missing valid "params" field`
              );
            }
          }
        }

        // Check requestState if present
        if (
          'requestState' in r1Result &&
          typeof r1Result.requestState !== 'string'
        ) {
          structureErrors.push(
            `requestState should be a string, got ${typeof r1Result.requestState}`
          );
        }
      }

      checks.push({
        id: 'incomplete-result-validate-incomplete-result-fields',
        name: 'IncompleteResultValidateIncompleteResultFields',
        description:
          'IncompleteResult has correct result_type, inputRequests, and requestState',
        status: structureErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          structureErrors.length > 0 ? structureErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r1Result }
      });

      // Check backward compatibility: final result with absent result_type
      if (r1Result && isIncompleteResult(r1Result)) {
        const inputKey = Object.keys(
          r1Result.inputRequests as Record<string, unknown>
        )[0];
        const r2 = await session.send('tools/call', {
          name: 'test_incomplete_result_validate_structure',
          arguments: {},
          inputResponses: {
            [inputKey]: mockElicitResponse({ value: 'test' })
          },
          requestState:
            typeof r1Result.requestState === 'string'
              ? r1Result.requestState
              : undefined
        });

        const r2Result = r2.result;
        const compatErrors: string[] = [];

        if (r2.error) {
          compatErrors.push(`JSON-RPC error: ${r2.error.message}`);
        } else if (!r2Result) {
          compatErrors.push('No result from retry');
        } else {
          // result_type should be absent or "complete" for backward compat
          if (
            'result_type' in r2Result &&
            r2Result.result_type !== 'complete' &&
            r2Result.result_type !== undefined
          ) {
            compatErrors.push(
              `Final result should have result_type absent or "complete", got "${r2Result.result_type}"`
            );
          }
        }

        checks.push({
          id: 'incomplete-result-validate-complete-result-default',
          name: 'IncompleteResultValidateCompleteResultDefault',
          description:
            'Complete result has result_type absent or "complete" (backward compat)',
          status: compatErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            compatErrors.length > 0 ? compatErrors.join('; ') : undefined,
          specReferences: MRTR_SPEC_REFERENCES,
          details: { result: r2Result }
        });
      }
    } catch (error) {
      checks.push({
        id: 'incomplete-result-validate-incomplete-result-fields',
        name: 'IncompleteResultValidateIncompleteResultFields',
        description:
          'IncompleteResult has correct result_type, inputRequests, and requestState',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}

// ─── C2: InputRequest Types Validation ───────────────────────────────────────

export class InputRequestTypesScenario implements ClientScenario {
  name = 'input-request-types';
  specVersions: SpecVersion[] = ['draft'];
  description = `Validate all three InputRequest types in IncompleteResult.

**Server Implementation Requirements:**

Implement a tool named \`test_incomplete_result_input_types\` that returns an \`IncompleteResult\` containing all three types of \`InputRequest\`.

**Behavior:**

When called, return:

\`\`\`json
{
  "result_type": "incomplete",
  "inputRequests": {
    "elicit": {
      "method": "elicitation/create",
      "params": {
        "message": "Please provide a value",
        "requestedSchema": {
          "type": "object",
          "properties": { "value": { "type": "string" } },
          "required": ["value"]
        }
      }
    },
    "sample": {
      "method": "sampling/createMessage",
      "params": {
        "messages": [
          { "role": "user", "content": { "type": "text", "text": "Generate a response" } }
        ],
        "maxTokens": 100
      }
    },
    "roots": {
      "method": "roots/list",
      "params": {}
    }
  }
}
\`\`\`

When retried with valid \`inputResponses\` for all three, return a final result.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const session = await createIncompleteResultSession(serverUrl);

      const r1 = await session.send('tools/call', {
        name: 'test_incomplete_result_input_types',
        arguments: {}
      });

      const r1Result = r1.result;

      if (r1.error || !r1Result || !isIncompleteResult(r1Result)) {
        checks.push({
          id: 'incomplete-result-validate-input-types-prereq',
          name: 'IncompleteResultValidateInputTypesPrereq',
          description: 'Prerequisite: Get IncompleteResult',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: r1.error
            ? `JSON-RPC error: ${r1.error.message}`
            : 'Expected IncompleteResult',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      const inputRequests = r1Result.inputRequests as
        | Record<string, Record<string, unknown>>
        | undefined;

      if (!inputRequests) {
        checks.push({
          id: 'incomplete-result-validate-input-types-prereq',
          name: 'IncompleteResultValidateInputTypesPrereq',
          description: 'Prerequisite: inputRequests present',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'inputRequests missing from IncompleteResult',
          specReferences: MRTR_SPEC_REFERENCES
        });
        return checks;
      }

      // Find each type of InputRequest
      const foundTypes: Record<
        string,
        { key: string; request: Record<string, unknown> }
      > = {};
      for (const [key, value] of Object.entries(inputRequests)) {
        const method = value.method as string;
        if (method === 'elicitation/create')
          foundTypes['elicitation'] = { key, request: value };
        else if (method === 'sampling/createMessage')
          foundTypes['sampling'] = { key, request: value };
        else if (method === 'roots/list')
          foundTypes['roots'] = { key, request: value };
      }

      // Check elicitation
      const elicitErrors: string[] = [];
      if (!foundTypes['elicitation']) {
        elicitErrors.push('No elicitation/create InputRequest found');
      } else {
        const params = foundTypes['elicitation'].request.params as
          | Record<string, unknown>
          | undefined;
        if (!params) {
          elicitErrors.push('elicitation/create missing params');
        } else {
          if (typeof params.message !== 'string') {
            elicitErrors.push(
              'elicitation/create params.message should be a string'
            );
          }
          if (
            !params.requestedSchema ||
            typeof params.requestedSchema !== 'object'
          ) {
            elicitErrors.push(
              'elicitation/create params.requestedSchema should be an object'
            );
          }
        }
      }

      checks.push({
        id: 'incomplete-result-validate-elicitation-input-request',
        name: 'IncompleteResultValidateElicitationInputRequest',
        description: 'elicitation/create InputRequest has valid structure',
        status: elicitErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          elicitErrors.length > 0 ? elicitErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { request: foundTypes['elicitation']?.request }
      });

      // Check sampling
      const samplingErrors: string[] = [];
      if (!foundTypes['sampling']) {
        samplingErrors.push('No sampling/createMessage InputRequest found');
      } else {
        const params = foundTypes['sampling'].request.params as
          | Record<string, unknown>
          | undefined;
        if (!params) {
          samplingErrors.push('sampling/createMessage missing params');
        } else {
          if (!Array.isArray(params.messages)) {
            samplingErrors.push(
              'sampling/createMessage params.messages should be an array'
            );
          }
          if (typeof params.maxTokens !== 'number') {
            samplingErrors.push(
              'sampling/createMessage params.maxTokens should be a number'
            );
          }
        }
      }

      checks.push({
        id: 'incomplete-result-validate-sampling-input-request',
        name: 'IncompleteResultValidateSamplingInputRequest',
        description: 'sampling/createMessage InputRequest has valid structure',
        status: samplingErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          samplingErrors.length > 0 ? samplingErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { request: foundTypes['sampling']?.request }
      });

      // Check roots
      const rootsErrors: string[] = [];
      if (!foundTypes['roots']) {
        rootsErrors.push('No roots/list InputRequest found');
      } else {
        // roots/list has minimal params, just check structure
        if (!foundTypes['roots'].request.params) {
          rootsErrors.push('roots/list missing params');
        }
      }

      checks.push({
        id: 'incomplete-result-validate-roots-input-request',
        name: 'IncompleteResultValidateRootsInputRequest',
        description: 'roots/list InputRequest has valid structure',
        status: rootsErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          rootsErrors.length > 0 ? rootsErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { request: foundTypes['roots']?.request }
      });

      // Retry with responses for all three types
      const inputResponses: Record<string, unknown> = {};
      if (foundTypes['elicitation']) {
        inputResponses[foundTypes['elicitation'].key] = mockElicitResponse({
          value: 'test'
        });
      }
      if (foundTypes['sampling']) {
        inputResponses[foundTypes['sampling'].key] = mockSamplingResponse(
          'Generated response text'
        );
      }
      if (foundTypes['roots']) {
        inputResponses[foundTypes['roots'].key] = mockListRootsResponse();
      }

      const r2 = await session.send('tools/call', {
        name: 'test_incomplete_result_input_types',
        arguments: {},
        inputResponses,
        requestState:
          typeof r1Result.requestState === 'string'
            ? r1Result.requestState
            : undefined
      });

      const retryErrors: string[] = [];
      if (r2.error) {
        retryErrors.push(`JSON-RPC error: ${r2.error.message}`);
      } else if (!r2.result) {
        retryErrors.push('No result from retry');
      } else if (isIncompleteResult(r2.result)) {
        retryErrors.push(
          'Expected complete result after providing all inputResponses'
        );
      }

      checks.push({
        id: 'incomplete-result-validate-all-types-retry',
        name: 'IncompleteResultValidateAllTypesRetry',
        description:
          'Retry with all three InputResponse types produces final result',
        status: retryErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          retryErrors.length > 0 ? retryErrors.join('; ') : undefined,
        specReferences: MRTR_SPEC_REFERENCES,
        details: { result: r2.result }
      });
    } catch (error) {
      checks.push({
        id: 'incomplete-result-validate-input-types-prereq',
        name: 'IncompleteResultValidateInputTypesPrereq',
        description: 'Prerequisite: Get IncompleteResult with InputRequests',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: MRTR_SPEC_REFERENCES
      });
    }

    return checks;
  }
}
