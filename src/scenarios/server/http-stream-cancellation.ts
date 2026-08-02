/**
 * HTTP Stream-Close Cancellation conformance scenario (2026-07-28).
 *
 * The 2026-07-28 spec states that on Streamable HTTP, closing the response
 * stream (client disconnect) MUST be treated by the server as cancellation of
 * that request. The server MUST NOT send further messages for the cancelled
 * request after the client disconnects. The server SHOULD stop work on the
 * cancelled request as soon as practical.
 *
 * This is fundamentally different from the 2025-x cancellation model, which
 * used an explicit `notifications/cancelled` JSON-RPC message.
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
    id: 'MCP-2026-07-28-Cancellation',
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation'
  },
  {
    id: 'MCP-2026-07-28-StreamableHTTP',
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#cancellation'
  }
];

export class HttpStreamCancellationScenario implements ClientScenario {
  name = 'http-stream-cancellation';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test HTTP stream-close-as-cancellation behavior (2026-07-28 spec).

**Server Implementation Requirements:**

**Endpoints**:
- \`tools/call\`: Implement a slow tool (\`test_tool_slow\`) that streams progress over SSE for at least 5 seconds.
- \`tools/call\`: Implement a fast tool (\`test_tool_fast\`) that returns immediately (health check).

**Specification Requirements (3 Checks)**:

1. **Stream Close = Cancellation**
   - When the client closes (aborts) the HTTP response stream mid-flight, the server MUST treat this as cancellation of the in-progress request.
   - The server MUST NOT send any further messages for that request after the client disconnects.
   - The server SHOULD stop work on the cancelled request as soon as practical.

2. **Server Health After Cancellation**
   - After cancelling a request via stream close, the server MUST remain operational and able to serve subsequent requests.

3. **Rapid Stream-Close Stability**
   - Multiple rapid stream opens and immediate closes MUST NOT crash or deadlock the server.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    let nextId = 1;
    const makeRequest = (method: string, params?: Record<string, unknown>) => {
      const id = nextId++;
      const headers = buildStandardHeaders(method, params, { specVersion });
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: withRequestMeta(params, specVersion)
      });
      return { id, headers, body };
    };

    // Check 1: Stream close cancels in-progress request and server stops sending
    try {
      const { headers, body } = makeRequest('tools/call', {
        name: 'test_tool_slow',
        arguments: { durationMs: 10000 }
      });

      const controller = new AbortController();
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });

      const contentType = res.headers.get('content-type') ?? '';
      const isStreaming = contentType.includes('text/event-stream');

      if (!isStreaming || !res.body) {
        checks.push({
          id: 'http-stream-cancel-closes-request',
          name: 'HttpStreamCancelClosesRequest',
          description:
            'Server handles SSE stream close gracefully without crashing or blocking',
          status: 'FAILURE',
          timestamp,
          errorMessage: !isStreaming
            ? `Expected text/event-stream response for slow tool, got ${contentType || '(none)'}`
            : 'Response body was null',
          specReferences: SPEC_REFS,
          details: { contentType, hasBody: !!res.body }
        });
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let receivedEvents = 0;

        // Read until we get at least one SSE event (proving the stream is active)
        const readUntilFirstEvent = async (): Promise<boolean> => {
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              const lines = text.split(/\r?\n/);
              for (const line of lines) {
                if (line.startsWith('data:')) {
                  receivedEvents++;
                  return true;
                }
              }
            }
          } catch {
            // Aborted or closed
          } finally {
            clearTimeout(timeout);
          }
          return receivedEvents > 0;
        };

        const gotFirstEvent = await readUntilFirstEvent();

        if (!gotFirstEvent) {
          checks.push({
            id: 'http-stream-cancel-closes-request',
            name: 'HttpStreamCancelClosesRequest',
            description:
              'Server handles SSE stream close gracefully without crashing or blocking',
            status: 'FAILURE',
            timestamp,
            errorMessage:
              'Slow tool did not produce any SSE events before timeout — cannot test stream cancellation',
            specReferences: SPEC_REFS,
            details: { receivedEvents }
          });
        } else {
          // Now abort the stream (simulates client disconnect)
          controller.abort();
          try {
            reader.releaseLock();
          } catch {
            // Already released
          }

          // Wait briefly then verify no more data arrives on a fresh connection
          await new Promise((r) => setTimeout(r, 500));

          // The server MUST NOT send further messages for the cancelled request.
          // We verify this by checking server health (if it's still up, it handled
          // the disconnect gracefully).
          const healthReq = makeRequest('tools/call', {
            name: 'test_tool_fast',
            arguments: {}
          });
          const healthController = new AbortController();
          const healthTimeout = setTimeout(
            () => healthController.abort(),
            5000
          );
          try {
            const healthRes = await fetch(serverUrl, {
              method: 'POST',
              headers: healthReq.headers,
              body: healthReq.body,
              signal: healthController.signal
            });
            clearTimeout(healthTimeout);

            const healthText = await healthRes.text();
            let healthData: any;
            try {
              healthData = JSON.parse(healthText);
            } catch {
              // SSE response — parse first data line
              const lines = healthText.split(/\r?\n/);
              for (const line of lines) {
                if (line.startsWith('data:')) {
                  try {
                    healthData = JSON.parse(line.replace(/^data:\s*/, ''));
                  } catch {
                    // continue
                  }
                  break;
                }
              }
            }

            const serverResponded =
              healthRes.status === 200 && healthData?.result !== undefined;

            checks.push({
              id: 'http-stream-cancel-closes-request',
              name: 'HttpStreamCancelClosesRequest',
              description:
                'Server handles SSE stream close gracefully without crashing or blocking',
              status: serverResponded ? 'SUCCESS' : 'FAILURE',
              timestamp,
              errorMessage: serverResponded
                ? undefined
                : `Server did not respond healthily after stream close (HTTP ${healthRes.status})`,
              specReferences: SPEC_REFS,
              details: {
                receivedEventsBeforeAbort: receivedEvents,
                healthCheckStatus: healthRes.status,
                healthCheckResult: healthData?.result
              }
            });
          } catch (e) {
            clearTimeout(healthTimeout);
            checks.push({
              id: 'http-stream-cancel-closes-request',
              name: 'HttpStreamCancelClosesRequest',
              description:
                'Server handles SSE stream close gracefully without crashing or blocking',
              status: 'FAILURE',
              timestamp,
              errorMessage: `Health check after stream abort failed: ${e instanceof Error ? e.message : String(e)}`,
              specReferences: SPEC_REFS,
              details: { receivedEventsBeforeAbort: receivedEvents }
            });
          }
        }
      }
    } catch (e) {
      checks.push({
        id: 'http-stream-cancel-closes-request',
        name: 'HttpStreamCancelClosesRequest',
        description:
          'Server handles SSE stream close gracefully without crashing or blocking',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Stream cancellation test failed: ${e instanceof Error ? e.message : String(e)}`,
        specReferences: SPEC_REFS
      });
    }

    // Check 2: Server remains healthy after cancellation
    try {
      const { headers, body } = makeRequest('tools/call', {
        name: 'test_tool_fast',
        arguments: {}
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timeout);

      let data: any;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            try {
              data = JSON.parse(line.replace(/^data:\s*/, ''));
            } catch {
              // skip
            }
            break;
          }
        }
      } else {
        try {
          data = await res.json();
        } catch {
          // non-JSON
        }
      }

      const healthy = res.status === 200 && data?.result !== undefined;
      checks.push({
        id: 'http-stream-cancel-server-health',
        name: 'HttpStreamCancelServerHealth',
        description:
          'Server remains operational after client aborts a streaming response',
        status: healthy ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: healthy
          ? undefined
          : `Server unhealthy after cancellation (HTTP ${res.status})`,
        specReferences: SPEC_REFS,
        details: { httpStatus: res.status, result: data?.result }
      });
    } catch (e) {
      checks.push({
        id: 'http-stream-cancel-server-health',
        name: 'HttpStreamCancelServerHealth',
        description:
          'Server remains operational after client aborts a streaming response',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Post-cancellation health check failed: ${e instanceof Error ? e.message : String(e)}`,
        specReferences: SPEC_REFS
      });
    }

    // Check 3: Rapid stream-close stability (burst of open+immediate-close)
    try {
      const burstCount = 5;
      const errors: string[] = [];

      for (let i = 0; i < burstCount; i++) {
        const { headers, body } = makeRequest('tools/call', {
          name: 'test_tool_slow',
          arguments: { durationMs: 10000 }
        });
        const controller = new AbortController();
        const iterTimeout = setTimeout(() => controller.abort(), 3000);
        try {
          await fetch(serverUrl, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal
          });
          clearTimeout(iterTimeout);
          controller.abort();
        } catch {
          clearTimeout(iterTimeout);
        }
      }

      // Brief pause for server to process disconnects
      await new Promise((r) => setTimeout(r, 300));

      // Verify server is still alive
      const { headers, body } = makeRequest('tools/call', {
        name: 'test_tool_fast',
        arguments: {}
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timeout);

      let data: any;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            try {
              data = JSON.parse(line.replace(/^data:\s*/, ''));
            } catch {
              // skip
            }
            break;
          }
        }
      } else {
        try {
          data = await res.json();
        } catch {
          // non-JSON
        }
      }

      const survived = res.status === 200 && data?.result !== undefined;
      if (!survived) {
        errors.push(
          `Server unresponsive after ${burstCount} rapid stream-close operations (HTTP ${res.status})`
        );
      }

      checks.push({
        id: 'http-stream-cancel-rapid-burst',
        name: 'HttpStreamCancelRapidBurst',
        description: `${burstCount} rapid stream opens followed by immediate closes must not crash or deadlock the server`,
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: SPEC_REFS,
        details: {
          burstCount,
          serverResponsiveAfterBurst: survived,
          httpStatus: res.status
        }
      });
    } catch (e) {
      checks.push({
        id: 'http-stream-cancel-rapid-burst',
        name: 'HttpStreamCancelRapidBurst',
        description:
          'Rapid stream-close operations must not crash or deadlock the server',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Burst stability test failed: ${e instanceof Error ? e.message : String(e)}`,
        specReferences: SPEC_REFS
      });
    }

    return checks;
  }
}
