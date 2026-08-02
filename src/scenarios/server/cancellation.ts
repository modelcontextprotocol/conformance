/**
 * Cancellation conformance test scenario for MCP servers.
 *
 * Validates that servers handle `notifications/cancelled` gracefully per spec:
 * - MUST NOT crash or enter invalid state on cancellation of unknown requests
 * - SHOULD stop processing cancelled in-progress requests
 * - MUST remain stable under rapid cancellation bursts
 *
 * Closes https://github.com/modelcontextprotocol/conformance/issues/433
 */

import { ClientScenario, ConformanceCheck } from '../../types';
import { type RunContext } from '../../connection';
import { connectToServer } from '../../connection/sdk-client';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Cancellation',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation'
  }
];

interface CheckDef {
  id: string;
  name: string;
  description: string;
}

const UNKNOWN_REQUEST_STABILITY: CheckDef = {
  id: 'cancellation-unknown-request-stability',
  name: 'CancellationUnknownRequestStability',
  description: 'Server remains stable after cancellation of unknown request ID'
};

const IN_PROGRESS_REQUEST: CheckDef = {
  id: 'cancellation-in-progress-request',
  name: 'CancellationInProgressRequest',
  description:
    'Server handles cancellation of in-progress request without degradation'
};

const RAPID_BURST_STABILITY: CheckDef = {
  id: 'cancellation-rapid-burst-stability',
  name: 'CancellationRapidBurstStability',
  description: 'Server remains stable under rapid cancellation notifications'
};

function check(
  def: CheckDef,
  status: ConformanceCheck['status'],
  extras: Pick<Partial<ConformanceCheck>, 'errorMessage' | 'details'> = {}
): ConformanceCheck {
  return {
    ...def,
    status,
    timestamp: new Date().toISOString(),
    specReferences: SPEC_REFERENCES,
    ...extras
  };
}

export class CancellationScenario implements ClientScenario {
  name = 'cancellation';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test cancellation notification handling.

**Server Implementation Requirements:**

**Notification**: \`notifications/cancelled\`

**Requirements**:
- Server MUST handle cancellation gracefully without crashing or entering an invalid state
- Server SHOULD stop processing the cancelled request and free associated resources
- Server MAY ignore cancellation if the request is unknown, already completed, or not cancellable
- The \`notifications/cancelled\` params MUST include \`requestId\` corresponding to the ID of a previously issued request

**Test Server Prerequisites:**
- Must expose a tool named \`test_tool_slow\` that accepts \`{ durationMs: number }\` and sleeps for that duration before returning
- Must expose a tool named \`test_tool_fast\` that completes immediately with a text response`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const { serverUrl, specVersion } = ctx;
    // Uses connectToServer() directly (not ctx.connect()) because the Connection
    // interface does not expose a notification() method needed to send
    // notifications/cancelled to the server.

    // Check 1: Server remains stable after receiving cancellation for unknown request
    try {
      const connection = await connectToServer(serverUrl, {}, specVersion);

      // Send cancellation notification for a request ID that was never issued.
      // The SDK client.notification() routes through the managed transport,
      // which includes session headers automatically.
      await connection.client.notification({
        method: 'notifications/cancelled',
        params: {
          requestId: 'nonexistent-request-99999',
          reason: 'Testing unknown request cancellation'
        }
      });

      // Verify server is still responsive
      const result = await connection.client.callTool({
        name: 'test_tool_fast',
        arguments: {}
      });

      await connection.close();

      if (!result || !result.content) {
        checks.push(
          check(UNKNOWN_REQUEST_STABILITY, 'FAILURE', {
            errorMessage:
              'Server did not respond after receiving cancellation for unknown request'
          })
        );
      } else {
        checks.push(
          check(UNKNOWN_REQUEST_STABILITY, 'SUCCESS', {
            details: { serverResponded: true }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(UNKNOWN_REQUEST_STABILITY, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    // Check 2: Cancellation of an in-progress request
    try {
      const connection = await connectToServer(serverUrl, {}, specVersion);
      const startTime = Date.now();

      // Start the slow tool call without awaiting completion
      const slowPromise = connection.client.callTool({
        name: 'test_tool_slow',
        arguments: { durationMs: 10000 }
      });

      // Wait for the server to begin processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Send cancellation. The SDK assigns sequential numeric request IDs;
      // after initialize (id=0), the first callTool gets id=1.
      await connection.client.notification({
        method: 'notifications/cancelled',
        params: {
          requestId: 1,
          reason: 'Client no longer needs this result'
        }
      });

      // Wait for the slow request to resolve, error, or timeout
      let timedOut = false;
      try {
        await Promise.race([
          slowPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 12000)
          )
        ]);
      } catch (e) {
        if (e instanceof Error && e.message === 'timeout') {
          timedOut = true;
        }
        // Other errors (e.g. request cancelled) are acceptable
      }

      const elapsed = Date.now() - startTime;

      // Verify server is still healthy after the cancellation exchange
      const healthCheck = await connection.client.callTool({
        name: 'test_tool_fast',
        arguments: {}
      });

      await connection.close();

      if (!healthCheck || !healthCheck.content) {
        checks.push(
          check(IN_PROGRESS_REQUEST, 'FAILURE', {
            errorMessage:
              'Server became unresponsive after cancellation of in-progress request',
            details: { elapsedMs: elapsed, timedOut }
          })
        );
      } else {
        checks.push(
          check(IN_PROGRESS_REQUEST, 'SUCCESS', {
            details: {
              elapsedMs: elapsed,
              cancelledEarly: elapsed < 9000,
              timedOut,
              healthCheckPassed: true
            }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(IN_PROGRESS_REQUEST, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    // Check 3: Multiple rapid cancellations do not crash the server
    try {
      const connection = await connectToServer(serverUrl, {}, specVersion);

      // Fire several cancellation notifications for nonexistent requests.
      // Server MAY ignore these but MUST remain stable.
      for (let i = 0; i < 5; i++) {
        await connection.client.notification({
          method: 'notifications/cancelled',
          params: {
            requestId: `burst-cancel-${i}`,
            reason: 'Rapid cancellation burst test'
          }
        });
      }

      // Verify server is still responsive
      const result = await connection.client.callTool({
        name: 'test_tool_fast',
        arguments: {}
      });

      await connection.close();

      if (!result || !result.content) {
        checks.push(
          check(RAPID_BURST_STABILITY, 'FAILURE', {
            errorMessage:
              'Server became unresponsive after rapid cancellation burst'
          })
        );
      } else {
        checks.push(
          check(RAPID_BURST_STABILITY, 'SUCCESS', {
            details: { cancellationCount: 5, serverResponded: true }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(RAPID_BURST_STABILITY, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    return checks;
  }
}
