/**
 * SEP-2663 Tasks Extension — status notifications conformance.
 *
 * **SKIPPED — pending subscriptions/listen rewrite.** SEP-2663 delivers
 * `notifications/tasks` over the `subscriptions/listen` stream defined
 * by SEP-2575, not over the POST SSE response of `tools/call`. This
 * scenario's harness reads SSE frames off the `tools/call` POST
 * response, so its observation point misses notifications on servers
 * that follow the spec — they emit on a stream this harness never
 * opens.
 *
 * The scenario is preserved here as a reference point; rewriting the
 * harness against subscriptions/listen is tracked as a follow-up.
 *
 * Required server fixtures (for the future re-enabled scenario):
 *   - slow_compute  — task-supporting, sleeps N seconds.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import { SEP_2663_REF } from './mrtr-helpers';
import { skipCheck } from './mrtr-helpers';

export class TasksStatusNotificationsScenario implements ClientScenario {
  name = 'tasks-status-notifications';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2663 status notifications (optional).

**Server Implementation Requirements:**

Servers MAY emit \`notifications/tasks\` on the subscriptions/listen
stream to inform clients of task state changes without polling.
Notifications are optional — a server is conformant whether it sends
them or not. When sent, the notification params MUST carry:

- \`taskId\`: the task the notification refers to.
- \`status\`: the new task status.
- For terminal statuses (\`completed\`/\`failed\`/\`cancelled\`),
  notifications MAY inline the corresponding \`result\` or \`error\`
  per the SEP-2663 DetailedTask shape.`;

  async run(_ctx: RunContext): Promise<ConformanceCheck[]> {
    // Prior implementation (POST-SSE observation harness on tools/call)
    // was removed in this commit; see git blame for the working code to
    // adapt when rewriting against subscriptions/listen.
    return [
      skipCheck(
        'tasks-status-notifications',
        'TasksStatusNotificationsScenario',
        'Status notifications conformance, pending subscriptions/listen rewrite.',
        'SEP-2663 delivers notifications/tasks via the SEP-2575 subscriptions/listen stream, not via the tools/call POST SSE response that the prior harness observed. The harness needs a rewrite against the new channel; tracked as a follow-up.',
        [SEP_2663_REF]
      )
    ];
  }
}
