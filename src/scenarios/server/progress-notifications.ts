/**
 * Progress notification edge-case conformance test scenario for MCP servers.
 *
 * Extends coverage beyond the basic progress check in tools.ts by validating:
 * - Non-decreasing progress values
 * - Token matching between request and notifications
 * - No spurious notifications when no progressToken is provided
 * - Cessation of notifications after request completion
 *
 * Closes https://github.com/modelcontextprotocol/conformance/issues/434
 */

import { ClientScenario, ConformanceCheck } from '../../types';
import type { RunContext } from '../../connection';
import type { CallToolResult } from '../../spec-types/2025-06-18';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Progress',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress'
  }
];

interface CheckDef {
  id: string;
  name: string;
  description: string;
}

const VALUES_NON_DECREASING: CheckDef = {
  id: 'progress-values-non-decreasing',
  name: 'ProgressValuesNonDecreasing',
  description: 'Progress values are non-decreasing and total is consistent'
};

const TOKEN_MATCHES_REQUEST: CheckDef = {
  id: 'progress-token-matches-request',
  name: 'ProgressTokenMatchesRequest',
  description:
    'Progress notifications reference the correct token from the request'
};

const NO_TOKEN_NO_NOTIFICATIONS: CheckDef = {
  id: 'progress-no-token-no-notifications',
  name: 'ProgressNoTokenNoNotifications',
  description:
    'Server does not send progress notifications when no progressToken is provided'
};

const CEASES_AFTER_COMPLETION: CheckDef = {
  id: 'progress-ceases-after-completion',
  name: 'ProgressCeasesAfterCompletion',
  description: 'No progress notifications arrive after the request response'
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

interface ProgressParams {
  progressToken?: string | number;
  progress: number;
  total?: number;
}

export class ProgressNotificationsScenario implements ClientScenario {
  name = 'progress-notifications';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test progress notification semantics and constraints.

**Server Implementation Requirements:**

**Notification**: \`notifications/progress\`

**Requirements**:
- Progress tokens MUST be string or integer
- The \`progress\` value MUST be non-decreasing across notifications for the same token
- Progress notifications MUST reference tokens from active requests only
- Progress notifications MUST cease after the request completes
- If \`total\` is provided, it SHOULD remain consistent or increase
- \`progress\` SHOULD NOT exceed \`total\` when total is provided
- Server MAY choose not to send progress notifications at all

**Test Server Prerequisites:**
- Must expose \`test_tool_with_progress\` that emits at least 3 progress notifications when a progressToken is provided`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    // Check 1: Progress values are non-decreasing
    try {
      const conn = await ctx.connect();
      await conn.request<CallToolResult>('tools/call', {
        name: 'test_tool_with_progress',
        arguments: {},
        _meta: { progressToken: 'progress-ordering-test' }
      });

      const progressUpdates = conn.notifications
        .filter((n) => n.method === 'notifications/progress')
        .map((n) => n.params as ProgressParams)
        .filter((p) => p.progressToken === 'progress-ordering-test');

      await conn.close();

      if (progressUpdates.length === 0) {
        checks.push(
          check(VALUES_NON_DECREASING, 'INFO', {
            errorMessage:
              'No progress notifications received. Server MAY choose not to send them.',
            details: { progressCount: 0 }
          })
        );
      } else {
        const errors: string[] = [];
        const warnings: string[] = [];

        for (let i = 1; i < progressUpdates.length; i++) {
          if (progressUpdates[i].progress < progressUpdates[i - 1].progress) {
            errors.push(
              `Progress decreased: ${progressUpdates[i - 1].progress} -> ${progressUpdates[i].progress} at index ${i}`
            );
            break;
          }
        }

        const totals = progressUpdates
          .filter((p) => p.total !== undefined)
          .map((p) => p.total as number);
        if (totals.length > 1) {
          for (let i = 1; i < totals.length; i++) {
            if (totals[i] < totals[i - 1]) {
              warnings.push(
                `Total decreased: ${totals[i - 1]} -> ${totals[i]} at index ${i}`
              );
              break;
            }
          }
        }

        for (const p of progressUpdates) {
          if (p.total !== undefined && p.progress > p.total) {
            warnings.push(
              `Progress (${p.progress}) exceeds total (${p.total})`
            );
            break;
          }
        }

        const status =
          errors.length > 0
            ? 'FAILURE'
            : warnings.length > 0
              ? 'WARNING'
              : 'SUCCESS';

        checks.push(
          check(VALUES_NON_DECREASING, status, {
            errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
            details: {
              progressCount: progressUpdates.length,
              warnings: warnings.length > 0 ? warnings : undefined,
              values: progressUpdates.map((p) => ({
                progress: p.progress,
                total: p.total
              }))
            }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(VALUES_NON_DECREASING, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    // Check 2: Progress token in notifications matches the one sent in _meta
    try {
      const conn = await ctx.connect();
      const token = 'unique-token-match-test-42';
      await conn.request<CallToolResult>('tools/call', {
        name: 'test_tool_with_progress',
        arguments: {},
        _meta: { progressToken: token }
      });

      const progressUpdates = conn.notifications
        .filter((n) => n.method === 'notifications/progress')
        .map((n) => n.params as ProgressParams);

      await conn.close();

      if (progressUpdates.length === 0) {
        checks.push(
          check(TOKEN_MATCHES_REQUEST, 'INFO', {
            errorMessage:
              'No progress notifications received; token matching cannot be validated.',
            details: { expectedToken: token }
          })
        );
      } else {
        const mismatched = progressUpdates.filter(
          (p) => p.progressToken !== token
        );
        if (mismatched.length > 0) {
          checks.push(
            check(TOKEN_MATCHES_REQUEST, 'FAILURE', {
              errorMessage: `Received notifications with wrong token: expected "${token}", got "${mismatched[0].progressToken}"`,
              details: {
                expectedToken: token,
                receivedTokens: progressUpdates.map((p) => p.progressToken)
              }
            })
          );
        } else {
          checks.push(
            check(TOKEN_MATCHES_REQUEST, 'SUCCESS', {
              details: {
                expectedToken: token,
                notificationCount: progressUpdates.length
              }
            })
          );
        }
      }
    } catch (error) {
      checks.push(
        check(TOKEN_MATCHES_REQUEST, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    // Check 3: No progress notifications for requests without progressToken
    try {
      const conn = await ctx.connect();
      await conn.request<CallToolResult>('tools/call', {
        name: 'test_tool_with_progress',
        arguments: {}
      });

      const progressUpdates = conn.notifications.filter(
        (n) => n.method === 'notifications/progress'
      );

      await conn.close();

      if (progressUpdates.length > 0) {
        checks.push(
          check(NO_TOKEN_NO_NOTIFICATIONS, 'FAILURE', {
            errorMessage: `Received ${progressUpdates.length} progress notifications for a request without progressToken`,
            details: { unexpectedCount: progressUpdates.length }
          })
        );
      } else {
        checks.push(
          check(NO_TOKEN_NO_NOTIFICATIONS, 'SUCCESS', {
            details: { unexpectedCount: 0 }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(NO_TOKEN_NO_NOTIFICATIONS, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    // Check 4: Progress notifications cease after request completes
    try {
      const conn = await ctx.connect();
      const token = 'cessation-test-token';
      await conn.request<CallToolResult>('tools/call', {
        name: 'test_tool_with_progress',
        arguments: {},
        _meta: { progressToken: token }
      });

      const countAtCompletion = conn.notifications
        .filter((n) => n.method === 'notifications/progress')
        .filter(
          (n) => (n.params as ProgressParams)?.progressToken === token
        ).length;

      // Wait briefly to catch any late notifications
      await new Promise((resolve) => setTimeout(resolve, 200));

      const countAfterWait = conn.notifications
        .filter((n) => n.method === 'notifications/progress')
        .filter(
          (n) => (n.params as ProgressParams)?.progressToken === token
        ).length;

      await conn.close();

      const lateCount = countAfterWait - countAtCompletion;
      if (lateCount > 0) {
        checks.push(
          check(CEASES_AFTER_COMPLETION, 'FAILURE', {
            errorMessage: `Received ${lateCount} progress notifications after request completed`,
            details: { countAtCompletion, countAfterWait, lateCount }
          })
        );
      } else {
        checks.push(
          check(CEASES_AFTER_COMPLETION, 'SUCCESS', {
            details: { countAtCompletion, lateNotifications: 0 }
          })
        );
      }
    } catch (error) {
      checks.push(
        check(CEASES_AFTER_COMPLETION, 'FAILURE', {
          errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }

    return checks;
  }
}
