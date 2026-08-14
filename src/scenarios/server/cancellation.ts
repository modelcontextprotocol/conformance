/**
 * Cancellation conformance test scenario for MCP servers.
 *
 * Validates that servers handle `notifications/cancelled` gracefully per spec:
 * - Receivers MAY ignore cancellation for unknown/completed request IDs
 * - Senders MUST reference previously issued, believed-active request IDs
 * - SHOULD stop processing cancelled in-progress requests
 * - Invalid cancellations SHOULD be ignored (not crash or degrade)
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
  description:
    'Server SHOULD remain stable under rapid cancellation notifications for unknown IDs'
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
- Server MAY ignore cancellation if the request is unknown, already completed, or not cancellable
- Invalid cancellations SHOULD be ignored without degradation
- Server SHOULD stop processing the cancelled request and free associated resources
- Senders MUST include \`requestId\` corresponding to a previously issued, believed-active request

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
    // Note: The SDK manages request IDs internally. We assume initialize=0,
    // first callTool=1. If wrong, the server MAY ignore it as an unknown ID,
    // which is spec-compliant. We use timing to distinguish actual cancellation
    // from the server simply ignoring the notification.
    try {
      const connection = await connectToServer(serverUrl, {}, specVersion);
      const startTime = Date.now();

      const slowPromise = connection.client.callTool({
        name: 'test_tool_slow',
        arguments: { durationMs: 10000 }
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      await connection.client.notification({
        method: 'notifications/cancelled',
        params: {
          requestId: 1,
          reason: 'Client no longer needs this result'
        }
      });

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
      }

      const elapsed = Date.now() - startTime;
      const cancelledEarly = elapsed < 9000;

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
      } else if (cancelledEarly) {
        checks.push(
          check(IN_PROGRESS_REQUEST, 'SUCCESS', {
            details: {
              elapsedMs: elapsed,
              cancelledEarly: true,
              healthCheckPassed: true
            }
          })
        );
      } else {
        checks.push(
          check(IN_PROGRESS_REQUEST, 'INFO', {
            errorMessage:
              'Server remained healthy but did not cancel early. ' +
              'The server MAY ignore cancellation for unknown or non-cancellable requests.',
            details: {
              elapsedMs: elapsed,
              cancelledEarly: false,
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
          check(RAPID_BURST_STABILITY, 'WARNING', {
            errorMessage:
              'Server became unresponsive after rapid cancellation burst. ' +
              'The spec allows ignoring invalid cancellations but servers ' +
              'SHOULD remain stable.'
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
