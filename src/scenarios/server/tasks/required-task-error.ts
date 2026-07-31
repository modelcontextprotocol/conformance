/**
 * SEP-2663 Tasks Extension — required-task error conformance.
 *
 * SEP-2575 (Stateless MCP) §"Missing Required Capabilities" defines
 * the `MissingRequiredClientCapability` JSON-RPC error code (-32021) for
 * the case where a server cannot service a request without a client
 * capability the client did not declare. SEP-2663 §"Required
 * Capabilities" applies that rule to the tasks extension: if a tool's
 * declared task support is "required" and the client did not declare
 * `io.modelcontextprotocol/tasks` during `initialize`, the server MUST
 * reject with that error. The error data
 * SHOULD carry a `requiredCapabilities` object whose shape mirrors the
 * `InitializeRequest` capabilities, so the client can self-describe
 * what to add without needing out-of-band documentation.
 *
 * This scenario verifies the failure path:
 *   1. Initialize a session WITHOUT declaring the tasks extension.
 *   2. Call a tool whose task support is `required`.
 *   3. Expect a JSON-RPC error with `code: -32021` and
 *      `data.requiredCapabilities.extensions["io.modelcontextprotocol/tasks"]`
 *      present.
 *
 * Required server fixtures:
 *   - failing_job — a tool registered with task support declared as
 *                   `required`. The tool's payload behaviour is
 *                   irrelevant; only the registration-time declaration
 *                   matters because the error is returned by the
 *                   middleware before the handler runs.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { MISSING_REQUIRED_CLIENT_CAPABILITY } from '../../../spec-types/draft';
import { SEP_2575_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg } from './mrtr-helpers';
import { TASKS_EXTENSION_ID } from './helpers';

const REQUIRED_TASK_TOOL = 'failing_job';

export class TasksRequiredTaskErrorScenario implements ClientScenario {
  name = 'tasks-required-task-error';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Verify the -32021 error path for required-task tools when the
client has not negotiated the io.modelcontextprotocol/tasks extension.

**Server Implementation Requirements:**

Per SEP-2575 §"Missing Required Capabilities" and SEP-2663 §"Required
Capabilities":

> If a server is unable to service a request to a client that does not
> declare this extension capability without returning \`CreateTaskResult\`,
> the server MUST return an error with the code \`-32021\` (Missing
> Required Client Capability), indicating the required extension in the
> error response.

The error data SHOULD include a \`requiredCapabilities\` object whose
shape mirrors \`InitializeRequest.capabilities\`, e.g.

\`\`\`json
{
  "requiredCapabilities": {
    "extensions": {
      "io.modelcontextprotocol/tasks": {}
    }
  }
}
\`\`\`

The scenario calls \`tools/call\` for a tool registered with task support
\`required\` from a client that did NOT declare the extension. A
conformant server MUST reject with \`-32021\`.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`failing_job\` — registered with task support declared as \`required\`.
  The tool's payload behavior is irrelevant; only the registration-time
  declaration matters, because the error is returned by the middleware
  before the handler runs.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let conn: Connection;
    try {
      // Intentionally declare NO capabilities — the point of the test is
      // to exercise the "did not negotiate the tasks extension" path.
      conn = await ctx.connect({
        capabilities: {}
      });
    } catch (error) {
      checks.push({
        id: 'tasks-required-error-bootstrap',
        name: 'TasksRequiredErrorBootstrap',
        description:
          'Initialize handshake without the tasks extension capability succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2575_REF, SEP_2663_REF]
      });
      return checks;
    }

    // Check 1: tools/call for a required-task tool returns the
    // MissingRequiredClientCapability error.
    const id = 'sep-2663-server-returns-missing-capability-when-required';
    const name = 'Sep2663ServerReturnsMissingCapabilityWhenRequired';
    const description = `tools/call for a TaskSupport=required tool MUST reject with code ${MISSING_REQUIRED_CLIENT_CAPABILITY} (Missing Required Client Capability) when the client did not declare ${TASKS_EXTENSION_ID}`;

    let observed: { code?: number; data?: unknown } = {};
    let errored = false;
    try {
      await conn.request('tools/call', {
        name: REQUIRED_TASK_TOOL,
        arguments: {}
      });
    } catch (error) {
      errored = true;
      if (error instanceof McpError) {
        observed = { code: error.code, data: error.data };
      } else if (error && typeof error === 'object') {
        const anyErr = error as any;
        observed = {
          code: typeof anyErr.code === 'number' ? anyErr.code : undefined,
          data: anyErr.data
        };
      }
    }

    if (!errored) {
      checks.push({
        id,
        name,
        description,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `tools/call for ${REQUIRED_TASK_TOOL} returned a successful response from a client that did not declare ${TASKS_EXTENSION_ID}; spec requires ${MISSING_REQUIRED_CLIENT_CAPABILITY} rejection in this case.`,
        specReferences: [SEP_2575_REF, SEP_2663_REF]
      });
      await conn.close().catch(() => {});
      return checks;
    }

    if (observed.code !== MISSING_REQUIRED_CLIENT_CAPABILITY) {
      checks.push({
        id,
        name,
        description,
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `tools/call for ${REQUIRED_TASK_TOOL} returned error code ${observed.code ?? '(unknown)'}; spec requires ${MISSING_REQUIRED_CLIENT_CAPABILITY}.`,
        specReferences: [SEP_2575_REF, SEP_2663_REF],
        details: { observedCode: observed.code }
      });
      await conn.close().catch(() => {});
      return checks;
    }

    checks.push({
      id,
      name,
      description,
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SEP_2575_REF, SEP_2663_REF]
    });

    // Check 2: the error data carries the structured `requiredCapabilities`
    // payload so a client can self-describe what to add. SHOULD, but the
    // canonical error example in the spec shows this shape; flag a
    // FAILURE only when the field shape is broken, not when it's absent.
    {
      const id2 = 'sep-2663-server-returns-missing-capability-data-shape';
      const name2 = 'Sep2663ServerReturnsMissingCapabilityDataShape';
      const description2 = `Error data for ${MISSING_REQUIRED_CLIENT_CAPABILITY} SHOULD carry data.requiredCapabilities.extensions["${TASKS_EXTENSION_ID}"]`;
      const data = observed.data as any;
      if (data === undefined || data === null) {
        checks.push({
          id: id2,
          name: name2,
          description: description2,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          errorMessage: `Error returned ${MISSING_REQUIRED_CLIENT_CAPABILITY} but carried no \`data\` field; the spec example shows requiredCapabilities, but data is SHOULD.`,
          specReferences: [SEP_2575_REF, SEP_2663_REF]
        });
      } else if (
        typeof data !== 'object' ||
        Array.isArray(data) ||
        !data.requiredCapabilities ||
        typeof data.requiredCapabilities !== 'object' ||
        !data.requiredCapabilities.extensions ||
        typeof data.requiredCapabilities.extensions !== 'object' ||
        data.requiredCapabilities.extensions[TASKS_EXTENSION_ID] === undefined
      ) {
        checks.push({
          id: id2,
          name: name2,
          description: description2,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Error data shape does not include requiredCapabilities.extensions["${TASKS_EXTENSION_ID}"]; got data = ${JSON.stringify(data)}`,
          specReferences: [SEP_2575_REF, SEP_2663_REF]
        });
      } else {
        checks.push({
          id: id2,
          name: name2,
          description: description2,
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [SEP_2575_REF, SEP_2663_REF]
        });
      }
    }

    await conn.close().catch(() => {});
    return checks;
  }
}
