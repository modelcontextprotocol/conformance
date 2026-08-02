/**
 * Per-Request LogLevel conformance scenario (2026-07-28).
 *
 * The 2026-07-28 spec replaces session-level `logging/setLevel` with per-request
 * logLevel in `_meta.io.modelcontextprotocol/logLevel`. This scenario tests:
 *
 * - Positive: log messages ARE emitted when logLevel is set
 * - Filtering: only messages at or above the requested severity are delivered
 * - Invalid: unrecognized logLevel values are rejected with -32602
 * - Scoping: log messages appear only on the request's own response stream
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  buildStandardHeaders,
  withRequestMeta,
  type RunContext
} from '../../connection';

const SPEC_REFS = [
  {
    id: 'MCP-2026-07-28-Logging',
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging'
  }
];

const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency'
] as const;

function levelIndex(level: string): number {
  return LOG_LEVELS.indexOf(level as (typeof LOG_LEVELS)[number]);
}

export class PerRequestLogLevelScenario implements ClientScenario {
  name = 'per-request-loglevel';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test per-request logLevel behavior (2026-07-28 spec).

**Server Implementation Requirements:**

**Endpoints**:
- \`tools/call\`: Implement a tool (\`test_logging_tool\`) that emits log messages at multiple severity levels (debug, info, warning, error) via \`notifications/message\` on the response stream.

**Specification Requirements (4 Checks)**:

1. **Positive Emission**
   - When \`_meta.io.modelcontextprotocol/logLevel\` is present, the server MAY emit \`notifications/message\` on the response stream at or above the requested level.
   - Verify at least one log message appears when logLevel is set to "debug".

2. **Severity Filtering**
   - The server MUST NOT deliver log messages below the requested severity level.
   - Setting logLevel to "error" means no debug/info/notice/warning messages.

3. **Invalid LogLevel Rejection**
   - If the logLevel value is not a recognized severity level, the server SHOULD respond with a -32602 (Invalid params) error.

4. **Request-Scoped Delivery**
   - Log messages MUST appear only on the response stream of the request that set logLevel, not on concurrent streams.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    let nextId = 1;

    const sendRequest = async (
      method: string,
      params?: Record<string, unknown>,
      timeoutMs = 5000
    ): Promise<{ status: number; events: any[]; body: any }> => {
      const id = nextId++;
      const headers = buildStandardHeaders(method, params, { specVersion });
      const reqBody = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: withRequestMeta(params, specVersion)
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(serverUrl, {
          method: 'POST',
          headers,
          body: reqBody,
          signal: controller.signal
        });
        clearTimeout(timeout);

        const ct = res.headers.get('content-type') ?? '';
        const events: any[] = [];
        let body: any = null;

        if (ct.includes('text/event-stream')) {
          const text = await res.text();
          for (const line of text.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
              try {
                const parsed = JSON.parse(line.replace(/^data:\s*/, ''));
                events.push(parsed);
                if (parsed.id === id) body = parsed;
              } catch {
                // skip
              }
            }
          }
          if (!body && events.length > 0) {
            body = events.find((e) => e.id === id) ?? events[events.length - 1];
          }
        } else {
          try {
            body = await res.json();
          } catch {
            // non-JSON
          }
        }

        return { status: res.status, events, body };
      } catch (e) {
        clearTimeout(timeout);
        throw e;
      }
    };

    // Track whether the server emits logs at all (used to avoid false positives)
    let serverEmitsLogs = false;

    // Check 1: Positive emission — logLevel "debug" produces log messages
    try {
      const { status, events, body } = await sendRequest('tools/call', {
        name: 'test_logging_tool',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/logLevel': 'debug'
        }
      });

      const logNotifications = events.filter(
        (e) => e.method === 'notifications/message'
      );

      if (status !== 200 && body?.error) {
        // Server doesn't implement the tool — mark as untestable
        checks.push({
          id: 'per-request-loglevel-positive-emission',
          name: 'PerRequestLogLevelPositiveEmission',
          description:
            'Server emits notifications/message when logLevel is set',
          status: 'FAILURE',
          timestamp,
          errorMessage: `test_logging_tool not available: error ${body.error.code} — ${body.error.message}`,
          specReferences: SPEC_REFS,
          details: { error: body.error }
        });
      } else if (logNotifications.length === 0) {
        checks.push({
          id: 'per-request-loglevel-positive-emission',
          name: 'PerRequestLogLevelPositiveEmission',
          description:
            'Server emits notifications/message when logLevel is set',
          status: 'WARNING',
          timestamp,
          errorMessage:
            'No notifications/message received with logLevel "debug" — server MAY emit but chose not to',
          specReferences: SPEC_REFS,
          details: { logLevel: 'debug', eventsReceived: events.length }
        });
      } else {
        serverEmitsLogs = true;
        checks.push({
          id: 'per-request-loglevel-positive-emission',
          name: 'PerRequestLogLevelPositiveEmission',
          description:
            'Server emits notifications/message when logLevel is set',
          status: 'SUCCESS',
          timestamp,
          specReferences: SPEC_REFS,
          details: {
            logLevel: 'debug',
            notificationCount: logNotifications.length,
            levels: logNotifications.map((n) => n.params?.level)
          }
        });
      }
    } catch (e) {
      checks.push({
        id: 'per-request-loglevel-positive-emission',
        name: 'PerRequestLogLevelPositiveEmission',
        description: 'Server emits notifications/message when logLevel is set',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Positive emission test failed: ${e instanceof Error ? e.message : String(e)}`,
        specReferences: SPEC_REFS
      });
    }

    // Check 2: Severity filtering — logLevel "error" suppresses lower levels
    if (!serverEmitsLogs) {
      checks.push({
        id: 'per-request-loglevel-severity-filtering',
        name: 'PerRequestLogLevelSeverityFiltering',
        description:
          'Server MUST NOT deliver log messages below the requested level',
        status: 'SKIPPED',
        timestamp,
        errorMessage:
          'Server did not emit any log messages in Check 1, so filtering cannot be verified',
        specReferences: SPEC_REFS
      });
    } else
      try {
        const { status, events, body } = await sendRequest('tools/call', {
          name: 'test_logging_tool',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/logLevel': 'error'
          }
        });

        const logNotifications = events.filter(
          (e) => e.method === 'notifications/message'
        );

        if (status !== 200 && body?.error) {
          checks.push({
            id: 'per-request-loglevel-severity-filtering',
            name: 'PerRequestLogLevelSeverityFiltering',
            description:
              'Server MUST NOT deliver log messages below the requested level',
            status: 'FAILURE',
            timestamp,
            errorMessage: `test_logging_tool not available: error ${body.error.code}`,
            specReferences: SPEC_REFS
          });
        } else {
          const errorLevelIdx = levelIndex('error');
          const belowThreshold = logNotifications.filter((n) => {
            const msgLevel = n.params?.level;
            const idx = levelIndex(msgLevel);
            return idx >= 0 && idx < errorLevelIdx;
          });

          if (belowThreshold.length > 0) {
            checks.push({
              id: 'per-request-loglevel-severity-filtering',
              name: 'PerRequestLogLevelSeverityFiltering',
              description:
                'Server MUST NOT deliver log messages below the requested level',
              status: 'FAILURE',
              timestamp,
              errorMessage: `Received ${belowThreshold.length} log message(s) below "error" level: ${belowThreshold.map((n) => n.params?.level).join(', ')}`,
              specReferences: SPEC_REFS,
              details: {
                requestedLevel: 'error',
                belowThresholdLevels: belowThreshold.map(
                  (n) => n.params?.level
                ),
                allReceivedLevels: logNotifications.map((n) => n.params?.level)
              }
            });
          } else {
            checks.push({
              id: 'per-request-loglevel-severity-filtering',
              name: 'PerRequestLogLevelSeverityFiltering',
              description:
                'Server MUST NOT deliver log messages below the requested level',
              status: 'SUCCESS',
              timestamp,
              specReferences: SPEC_REFS,
              details: {
                requestedLevel: 'error',
                messagesAtOrAbove: logNotifications.length,
                allReceivedLevels: logNotifications.map((n) => n.params?.level)
              }
            });
          }
        }
      } catch (e) {
        checks.push({
          id: 'per-request-loglevel-severity-filtering',
          name: 'PerRequestLogLevelSeverityFiltering',
          description:
            'Server MUST NOT deliver log messages below the requested level',
          status: 'FAILURE',
          timestamp,
          errorMessage: `Severity filtering test failed: ${e instanceof Error ? e.message : String(e)}`,
          specReferences: SPEC_REFS
        });
      }

    // Check 3: Invalid logLevel value — server SHOULD reject with -32602
    try {
      const { status, body } = await sendRequest('tools/call', {
        name: 'test_logging_tool',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/logLevel': 'banana'
        }
      });

      if (body?.error?.code === -32602) {
        checks.push({
          id: 'per-request-loglevel-invalid-rejection',
          name: 'PerRequestLogLevelInvalidRejection',
          description:
            'Server SHOULD reject unrecognized logLevel with -32602 Invalid params',
          status: 'SUCCESS',
          timestamp,
          specReferences: SPEC_REFS,
          details: { invalidLevel: 'banana', errorCode: body.error.code }
        });
      } else if (body?.error) {
        checks.push({
          id: 'per-request-loglevel-invalid-rejection',
          name: 'PerRequestLogLevelInvalidRejection',
          description:
            'Server SHOULD reject unrecognized logLevel with -32602 Invalid params',
          status: 'WARNING',
          timestamp,
          errorMessage: `Server returned error code ${body.error.code} instead of -32602 for invalid logLevel`,
          specReferences: SPEC_REFS,
          details: { invalidLevel: 'banana', error: body.error }
        });
      } else {
        // Server accepted the invalid level — this is a SHOULD, so WARNING
        checks.push({
          id: 'per-request-loglevel-invalid-rejection',
          name: 'PerRequestLogLevelInvalidRejection',
          description:
            'Server SHOULD reject unrecognized logLevel with -32602 Invalid params',
          status: 'WARNING',
          timestamp,
          errorMessage:
            'Server accepted unrecognized logLevel "banana" without error (SHOULD reject with -32602)',
          specReferences: SPEC_REFS,
          details: { invalidLevel: 'banana', httpStatus: status }
        });
      }
    } catch (e) {
      checks.push({
        id: 'per-request-loglevel-invalid-rejection',
        name: 'PerRequestLogLevelInvalidRejection',
        description:
          'Server SHOULD reject unrecognized logLevel with -32602 Invalid params',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Invalid logLevel test failed: ${e instanceof Error ? e.message : String(e)}`,
        specReferences: SPEC_REFS
      });
    }

    // Check 4: Request-scoped delivery — logs appear only on their own stream
    if (!serverEmitsLogs) {
      checks.push({
        id: 'per-request-loglevel-request-scoped',
        name: 'PerRequestLogLevelRequestScoped',
        description:
          'Log messages MUST appear only on the response stream of the request that set logLevel',
        status: 'SKIPPED',
        timestamp,
        errorMessage:
          'Server did not emit any log messages in Check 1, so request-scoped delivery cannot be verified',
        specReferences: SPEC_REFS
      });
    } else
      try {
        // Fire two concurrent requests: one WITH logLevel, one WITHOUT.
        // The one without logLevel MUST NOT receive any notifications/message.
        const id1 = nextId++;
        const id2 = nextId++;

        const makeReqBody = (
          id: number,
          toolName: string,
          meta?: Record<string, unknown>
        ) => {
          const params: Record<string, unknown> = {
            name: toolName,
            arguments: {}
          };
          if (meta) {
            params._meta = meta;
          }
          return JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: withRequestMeta(params, specVersion)
          });
        };

        const headers = buildStandardHeaders(
          'tools/call',
          { name: 'test_logging_tool' },
          { specVersion }
        );

        // Request 1: WITH logLevel (should get log messages)
        const controller1 = new AbortController();
        const timeout1 = setTimeout(() => controller1.abort(), 5000);
        const req1Promise = fetch(serverUrl, {
          method: 'POST',
          headers,
          body: makeReqBody(id1, 'test_logging_tool', {
            'io.modelcontextprotocol/logLevel': 'debug'
          }),
          signal: controller1.signal
        });

        // Request 2: WITHOUT logLevel (should NOT get log messages)
        const headers2 = buildStandardHeaders(
          'tools/call',
          { name: 'test_tool_fast' },
          { specVersion }
        );
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 5000);
        const req2Promise = fetch(serverUrl, {
          method: 'POST',
          headers: headers2,
          body: makeReqBody(id2, 'test_tool_fast', undefined),
          signal: controller2.signal
        });

        const [res1, res2] = await Promise.all([req1Promise, req2Promise]);
        clearTimeout(timeout1);
        clearTimeout(timeout2);

        // Parse events from response 2 (no logLevel)
        const events2: any[] = [];
        const ct2 = res2.headers.get('content-type') ?? '';
        if (ct2.includes('text/event-stream')) {
          const text = await res2.text();
          for (const line of text.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
              try {
                events2.push(JSON.parse(line.replace(/^data:\s*/, '')));
              } catch {
                // skip
              }
            }
          }
        }

        // Abort response 1 stream to prevent indefinite hang on SSE
        controller1.abort();
        try {
          await res1.text();
        } catch {
          // AbortError expected
        }

        const leakedLogs = events2.filter(
          (e) => e.method === 'notifications/message'
        );

        if (leakedLogs.length > 0) {
          checks.push({
            id: 'per-request-loglevel-request-scoped',
            name: 'PerRequestLogLevelRequestScoped',
            description:
              'Log messages MUST appear only on the response stream of the request that set logLevel',
            status: 'FAILURE',
            timestamp,
            errorMessage: `${leakedLogs.length} log notification(s) leaked onto a concurrent request that did not set logLevel`,
            specReferences: SPEC_REFS,
            details: { leakedLogs }
          });
        } else {
          checks.push({
            id: 'per-request-loglevel-request-scoped',
            name: 'PerRequestLogLevelRequestScoped',
            description:
              'Log messages MUST appear only on the response stream of the request that set logLevel',
            status: 'SUCCESS',
            timestamp,
            specReferences: SPEC_REFS,
            details: {
              concurrentStreamEvents: events2.length,
              leakedLogCount: 0
            }
          });
        }
      } catch (e) {
        checks.push({
          id: 'per-request-loglevel-request-scoped',
          name: 'PerRequestLogLevelRequestScoped',
          description:
            'Log messages MUST appear only on the response stream of the request that set logLevel',
          status: 'FAILURE',
          timestamp,
          errorMessage: `Request-scoped delivery test failed: ${e instanceof Error ? e.message : String(e)}`,
          specReferences: SPEC_REFS
        });
      }

    return checks;
  }
}
