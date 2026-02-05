/**
 * Session Isolation conformance test scenarios for MCP servers
 *
 * Tests that servers correctly isolate responses and notifications between
 * concurrent clients. Validates protection against GHSA-345p-7cg4-v4c7:
 *
 * - Issue 1 (Transport re-use): Shared transport's _requestToStreamMapping
 *   causes response cross-wiring when message IDs collide.
 *   → SessionIsolationScenario (deterministic, 2 clients)
 *
 * - Issue 2 (Server re-use): Shared server's this._transport reference is
 *   overwritten by new connections, causing in-request notifications to be
 *   routed to the wrong client.
 *   → NotificationIsolationScenario (deterministic, 2 clients)
 *   → NotificationIsolationFuzzScenario (N concurrent clients)
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';

const SPEC_REFERENCES = [
  {
    id: 'CWE-362',
    url: 'https://cwe.mitre.org/data/definitions/362.html'
  },
  {
    id: 'MCP-Transport-Security',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning'
  }
];

/**
 * Send a raw JSON-RPC request via fetch and parse the response.
 * Handles both application/json and text/event-stream response types.
 */
async function sendJsonRpcRequest(
  serverUrl: string,
  body: object,
  sessionId?: string
): Promise<{ status: number; headers: Headers; jsonRpcResponse: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26'
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get('content-type') || '';
  let jsonRpcResponse: any;

  if (contentType.includes('text/event-stream')) {
    // Parse SSE stream to extract the JSON-RPC response
    jsonRpcResponse = await parseSSEResponse(response);
  } else if (contentType.includes('application/json')) {
    // Direct JSON response
    jsonRpcResponse = await response.json();
  } else {
    // Non-JSON, non-SSE response (e.g. plain text error)
    const text = await response.text();
    jsonRpcResponse = { error: { code: -32603, message: text } };
  }

  return {
    status: response.status,
    headers: response.headers,
    jsonRpcResponse
  };
}

/**
 * Parse an SSE response body to extract the JSON-RPC message.
 * Returns null if the stream ends or times out without a JSON-RPC response.
 */
async function parseSSEResponse(
  response: Response,
  timeoutMs = 800
): Promise<any> {
  if (!response.body) {
    return null;
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  const readWithTimeout = async (): Promise<any> => {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );

    const read = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return null;

          if (value && value.data) {
            try {
              const parsed = JSON.parse(value.data);
              if (parsed.result !== undefined || parsed.error !== undefined) {
                return parsed;
              }
            } catch {
              // Skip non-JSON events
            }
          }
        }
      } catch {
        return null;
      }
    })();

    return Promise.race([read, timeout]);
  };

  try {
    return await readWithTimeout();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Collected SSE events from a stream, separated into notifications and the
 * final JSON-RPC response.
 */
interface SSEStreamResult {
  /** All JSON-RPC notification messages (no id, has method) */
  notifications: any[];
  /** The final JSON-RPC response (has result or error) */
  response: any | null;
}

/**
 * Parse an SSE response body collecting ALL events: notifications and the
 * final response. Used by notification isolation tests to verify that
 * in-request notifications (progress, logging) arrive on the correct stream.
 */
async function parseSSEStreamFull(
  response: Response,
  timeoutMs = 5000
): Promise<SSEStreamResult> {
  const result: SSEStreamResult = { notifications: [], response: null };

  if (!response.body) {
    return result;
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();

  const readAll = async (): Promise<void> => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;

        if (value && value.data) {
          try {
            const parsed = JSON.parse(value.data);
            if (parsed.result !== undefined || parsed.error !== undefined) {
              // Final response — we're done
              result.response = parsed;
              return;
            } else if (parsed.method) {
              // Notification (has method, no id for response)
              result.notifications.push(parsed);
            }
          } catch {
            // Skip non-JSON events
          }
        }
      }
    } catch {
      // Stream error — return what we have
    }
  };

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, timeoutMs)
  );

  try {
    await Promise.race([readAll(), timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }

  return result;
}

/**
 * Send a raw JSON-RPC request and return the raw Response object (unconsumed)
 * so the caller can parse the SSE stream themselves.
 */
async function sendJsonRpcRequestRaw(
  serverUrl: string,
  body: object,
  sessionId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26'
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  return fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

/**
 * Initialize a client session and send notifications/initialized.
 * Returns the session ID (if any) or throws on failure.
 */
async function initializeSession(
  serverUrl: string,
  messageId: number = 1,
  clientName: string = 'conformance-session-isolation-test'
): Promise<{ sessionId: string | undefined }> {
  const initBody = {
    jsonrpc: '2.0',
    id: messageId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' }
    }
  };

  const init = await sendJsonRpcRequest(serverUrl, initBody);
  if (init.status !== 200 || !init.jsonRpcResponse?.result) {
    throw new Error(`Initialize failed: status=${init.status}`);
  }

  const sessionId = init.headers.get('mcp-session-id') || undefined;

  await sendNotification(serverUrl, 'notifications/initialized', {}, sessionId);

  return { sessionId };
}

/**
 * Send a JSON-RPC notification (no id field, no response expected).
 */
async function sendNotification(
  serverUrl: string,
  method: string,
  params: object,
  sessionId?: string
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26'
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    })
  });
}

export class SessionIsolationScenario implements ClientScenario {
  name = 'session-isolation';
  description =
    'Test that concurrent clients with colliding JSON-RPC message IDs receive ' +
    'correctly routed responses (CWE-362 session isolation). Verifies that a ' +
    'server does not cross-wire responses when two clients use identical message IDs.';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // -- Step 1: Initialize two independent sessions --

    let sessionIdA: string | undefined;
    let sessionIdB: string | undefined;

    try {
      const initBody = {
        jsonrpc: '2.0',
        id: 1, // Both clients use the same message ID
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {
            name: 'conformance-session-isolation-test',
            version: '1.0.0'
          }
        }
      };

      // Initialize both clients (sequentially to avoid server-side init races)
      const initA = await sendJsonRpcRequest(serverUrl, initBody);
      sessionIdA = initA.headers.get('mcp-session-id') || undefined;

      const initB = await sendJsonRpcRequest(serverUrl, initBody);
      sessionIdB = initB.headers.get('mcp-session-id') || undefined;

      const bothInitSucceeded =
        initA.status === 200 &&
        initB.status === 200 &&
        initA.jsonRpcResponse?.result &&
        initB.jsonRpcResponse?.result;

      checks.push({
        id: 'session-isolation-init',
        name: 'SessionIsolationInit',
        description:
          'Both clients initialize successfully with the same message ID',
        status: bothInitSucceeded ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        details: {
          clientA: {
            status: initA.status,
            sessionId: sessionIdA || '(none)',
            hasResult: !!initA.jsonRpcResponse?.result
          },
          clientB: {
            status: initB.status,
            sessionId: sessionIdB || '(none)',
            hasResult: !!initB.jsonRpcResponse?.result
          }
        },
        errorMessage: !bothInitSucceeded
          ? `Initialization failed: Client A status=${initA.status}, Client B status=${initB.status}`
          : undefined
      });

      if (!bothInitSucceeded) {
        return checks;
      }

      // Send notifications/initialized for both sessions
      await sendNotification(
        serverUrl,
        'notifications/initialized',
        {},
        sessionIdA
      );
      await sendNotification(
        serverUrl,
        'notifications/initialized',
        {},
        sessionIdB
      );
    } catch (error) {
      checks.push({
        id: 'session-isolation-init',
        name: 'SessionIsolationInit',
        description: 'Both clients initialize successfully',
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Initialization error: ${error instanceof Error ? error.message : String(error)}`
      });
      return checks;
    }

    // -- Step 2: Send concurrent tools/call with colliding message IDs --

    try {
      // Both requests use the same JSON-RPC id to trigger the collision
      const textToolRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'test_simple_text',
          arguments: {}
        }
      };

      const imageToolRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'test_image_content',
          arguments: {}
        }
      };

      // Send the slow tool first (test_simple_text), wait briefly to ensure
      // it is in-flight, then send the fast tool (test_image_content).
      // Against a vulnerable stateless server, the second request overwrites
      // the first's _requestToStreamMapping entry while the slow tool is still
      // processing, causing deterministic cross-wiring.
      //
      // We resolve eagerly: once Client B's (fast) response arrives, we give
      // Client A a very short grace period. If cross-wiring happened, Client A's
      // response was stolen so there's nothing to wait for.
      const responseAPromise = sendJsonRpcRequest(
        serverUrl,
        textToolRequest,
        sessionIdA
      );
      await new Promise((r) => setTimeout(r, 100));
      const responseBPromise = sendJsonRpcRequest(
        serverUrl,
        imageToolRequest,
        sessionIdB
      );

      // Wait for B first (fast tool). If B got the wrong content type,
      // A's response was stolen — no point waiting for A at all.
      const responseB = await responseBPromise;
      const bContentType =
        responseB.jsonRpcResponse?.result?.content?.[0]?.type;
      const bCorrect = bContentType === 'image';

      const responseA = bCorrect
        ? await Promise.race([
            responseAPromise,
            // If A hasn't resolved 200ms after B, it's not coming
            new Promise<{
              status: number;
              headers: Headers;
              jsonRpcResponse: any;
            }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    status: 0,
                    headers: new Headers(),
                    jsonRpcResponse: null
                  }),
                200
              )
            )
          ])
        : { status: 0, headers: new Headers(), jsonRpcResponse: null };

      // Verify: Client A called test_simple_text -> should get content[0].type === "text"
      // Verify: Client B called test_image_content -> should get content[0].type === "image"
      const resultA = responseA.jsonRpcResponse?.result;
      const resultB = responseB.jsonRpcResponse?.result;

      const contentTypeA = resultA?.content?.[0]?.type;
      const contentTypeB = resultB?.content?.[0]?.type;

      // A null/undefined response means the stream timed out waiting for a response,
      // which happens when responses are cross-wired and the real response went to
      // the other client's stream.
      const clientAGotResponse = responseA.jsonRpcResponse != null;
      const clientBGotResponse = responseB.jsonRpcResponse != null;

      const clientACorrect = clientAGotResponse && contentTypeA === 'text';
      const clientBCorrect = clientBGotResponse && contentTypeB === 'image';
      const bothCorrect = clientACorrect && clientBCorrect;

      // Detect cross-wiring: any case where a client got the wrong response or
      // no response (timeout) indicates the server's internal mapping was corrupted.
      const crossWired = !bothCorrect;

      // Check for error responses (which can happen when the mapping is deleted
      // before the second response is sent)
      const errorA = responseA.jsonRpcResponse?.error;
      const errorB = responseB.jsonRpcResponse?.error;

      let errorMessage: string | undefined;
      if (!bothCorrect) {
        const describeResult = (
          contentType: string | undefined,
          error: any,
          gotResponse: boolean
        ) => {
          if (contentType) return `content type "${contentType}"`;
          if (error) return `error: ${error.message}`;
          if (!gotResponse) return 'no response (timeout)';
          return 'unknown';
        };

        errorMessage =
          'Responses were not correctly isolated between clients (CWE-362). ' +
          `Client A (test_simple_text) received: ${describeResult(contentTypeA, errorA, clientAGotResponse)} (expected "text"), ` +
          `Client B (test_image_content) received: ${describeResult(contentTypeB, errorB, clientBGotResponse)} (expected "image").`;
      }

      checks.push({
        id: 'session-isolation',
        name: 'SessionIsolation',
        description:
          'Each client receives the correct tool response when message IDs collide',
        status: bothCorrect ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        details: {
          clientA: {
            toolCalled: 'test_simple_text',
            expectedContentType: 'text',
            receivedContentType: contentTypeA || '(missing)',
            correct: clientACorrect,
            sessionId: sessionIdA || '(none)'
          },
          clientB: {
            toolCalled: 'test_image_content',
            expectedContentType: 'image',
            receivedContentType: contentTypeB || '(missing)',
            correct: clientBCorrect,
            sessionId: sessionIdB || '(none)'
          },
          crossWired
        },
        errorMessage
      });
    } catch (error) {
      checks.push({
        id: 'session-isolation',
        name: 'SessionIsolation',
        description:
          'Each client receives the correct tool response when message IDs collide',
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Tool call error: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    return checks;
  }
}

/**
 * Issue 2: Notification Isolation (deterministic, 2 clients)
 *
 * Tests that in-request notifications (progress) are routed to the correct
 * client when a shared server instance has its this._transport overwritten
 * by a second client connecting mid-handler.
 *
 * Requires the server to implement `test_tool_with_progress` which sends
 * progress notifications during execution.
 */
export class NotificationIsolationScenario implements ClientScenario {
  name = 'notification-isolation';
  description =
    'Test that in-request notifications (progress) are correctly isolated ' +
    'between concurrent clients. Client A calls a slow tool that emits ' +
    'progress notifications. Client B connects while A is still processing. ' +
    "Verifies that A's notifications do not leak to B's stream (Issue 2: " +
    'server re-use / this._transport overwrite).';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // -- Step 1: Initialize two sessions --

    let sessionIdA: string | undefined;
    let sessionIdB: string | undefined;

    try {
      const sessA = await initializeSession(
        serverUrl,
        1,
        'notification-isolation-A'
      );
      sessionIdA = sessA.sessionId;
      const sessB = await initializeSession(
        serverUrl,
        1,
        'notification-isolation-B'
      );
      sessionIdB = sessB.sessionId;
    } catch (error) {
      checks.push({
        id: 'notification-isolation',
        name: 'NotificationIsolation',
        description: 'Both clients initialize successfully',
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Initialization error: ${error instanceof Error ? error.message : String(error)}`
      });
      return checks;
    }

    // -- Step 2: Client A calls test_tool_with_progress (slow, emits notifications) --
    // While A is in-flight, Client B sends a request to trigger this._transport overwrite.

    try {
      // Client A: call the progress tool. Use a unique progressToken so we
      // can identify A's notifications if they leak to B.
      const progressRequestA = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'test_tool_with_progress',
          arguments: {},
          _meta: { progressToken: 'client-a-progress' }
        }
      };

      // Client B: call a simple tool (fast) with a different progressToken.
      const progressRequestB = {
        jsonrpc: '2.0',
        id: 2, // Same message ID to maximize collision potential
        method: 'tools/call',
        params: {
          name: 'test_tool_with_progress',
          arguments: {},
          _meta: { progressToken: 'client-b-progress' }
        }
      };

      // Fire A first, then B shortly after to create the race window
      const rawA = await sendJsonRpcRequestRaw(
        serverUrl,
        progressRequestA,
        sessionIdA
      );
      // Small delay to let A's handler start processing
      await new Promise((r) => setTimeout(r, 20));
      const rawB = await sendJsonRpcRequestRaw(
        serverUrl,
        progressRequestB,
        sessionIdB
      );

      // Parse both streams fully, collecting notifications + response
      const [streamA, streamB] = await Promise.all([
        parseSSEStreamFull(rawA, 5000),
        parseSSEStreamFull(rawB, 5000)
      ]);

      // -- Analyze results --

      // Extract progress tokens from notifications on each stream
      const progressTokensOnA = streamA.notifications
        .filter((n) => n.method === 'notifications/progress')
        .map((n) => n.params?.progressToken);

      const progressTokensOnB = streamB.notifications
        .filter((n) => n.method === 'notifications/progress')
        .map((n) => n.params?.progressToken);

      // A should only have 'client-a-progress' tokens
      const aHasOwnNotifications = progressTokensOnA.some(
        (t) => t === 'client-a-progress'
      );
      const aHasLeakedNotifications = progressTokensOnA.some(
        (t) => t === 'client-b-progress'
      );

      // B should only have 'client-b-progress' tokens
      const bHasOwnNotifications = progressTokensOnB.some(
        (t) => t === 'client-b-progress'
      );
      const bHasLeakedNotifications = progressTokensOnB.some(
        (t) => t === 'client-a-progress'
      );

      const aGotResponse = streamA.response != null;
      const bGotResponse = streamB.response != null;

      // Success criteria:
      // 1. No leaked notifications on either stream
      // 2. Each client received its own notifications (or at least got a response)
      const noLeaks = !aHasLeakedNotifications && !bHasLeakedNotifications;
      const bothGotResponses = aGotResponse && bGotResponse;

      const errors: string[] = [];
      if (aHasLeakedNotifications) {
        errors.push(
          `Client A received Client B's progress notifications (tokens: ${progressTokensOnA.join(', ')})`
        );
      }
      if (bHasLeakedNotifications) {
        errors.push(
          `Client B received Client A's progress notifications (tokens: ${progressTokensOnB.join(', ')})`
        );
      }
      if (!aGotResponse) {
        errors.push(
          'Client A did not receive a final response (possible cross-wiring)'
        );
      }
      if (!bGotResponse) {
        errors.push(
          'Client B did not receive a final response (possible cross-wiring)'
        );
      }
      if (!aHasOwnNotifications && aGotResponse) {
        // Not an error per se, but worth noting — could mean notifications were lost
        errors.push(
          'Client A received a response but no progress notifications (notifications may have been lost)'
        );
      }

      checks.push({
        id: 'notification-isolation',
        name: 'NotificationIsolation',
        description:
          'In-request progress notifications are routed to the correct client',
        status: noLeaks && bothGotResponses ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        details: {
          clientA: {
            sessionId: sessionIdA || '(none)',
            progressToken: 'client-a-progress',
            notificationCount: progressTokensOnA.length,
            tokensReceived: progressTokensOnA,
            hasOwnNotifications: aHasOwnNotifications,
            hasLeakedNotifications: aHasLeakedNotifications,
            gotResponse: aGotResponse
          },
          clientB: {
            sessionId: sessionIdB || '(none)',
            progressToken: 'client-b-progress',
            notificationCount: progressTokensOnB.length,
            tokensReceived: progressTokensOnB,
            hasOwnNotifications: bHasOwnNotifications,
            hasLeakedNotifications: bHasLeakedNotifications,
            gotResponse: bGotResponse
          }
        },
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined
      });
    } catch (error) {
      checks.push({
        id: 'notification-isolation',
        name: 'NotificationIsolation',
        description:
          'In-request progress notifications are routed to the correct client',
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Error: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    return checks;
  }
}

/**
 * Issue 2: Notification Isolation Fuzz Test (N concurrent clients)
 *
 * Sends N concurrent requests that each emit progress notifications with
 * unique tokens. Verifies that every client only receives notifications
 * with its own token — no cross-contamination.
 */
export class NotificationIsolationFuzzScenario implements ClientScenario {
  name = 'notification-isolation-fuzz';
  description =
    'Fuzz test: N concurrent clients each call test_tool_with_progress with ' +
    'unique progress tokens. Verifies that every notification arrives at the ' +
    'correct client and no cross-contamination occurs.';

  private clientCount: number;

  constructor(clientCount: number = 10) {
    this.clientCount = clientCount;
  }

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();
    const N = this.clientCount;

    // -- Step 1: Initialize N sessions --

    const sessions: Array<{ index: number; sessionId: string | undefined }> =
      [];

    try {
      // Initialize sequentially to avoid overwhelming the server
      for (let i = 0; i < N; i++) {
        const sess = await initializeSession(
          serverUrl,
          1,
          `notification-fuzz-client-${i}`
        );
        sessions.push({ index: i, sessionId: sess.sessionId });
      }
    } catch (error) {
      checks.push({
        id: 'notification-isolation-fuzz',
        name: 'NotificationIsolationFuzz',
        description: `All ${N} clients initialize successfully`,
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Initialization error after ${sessions.length}/${N} clients: ${error instanceof Error ? error.message : String(error)}`
      });
      return checks;
    }

    checks.push({
      id: 'notification-isolation-fuzz-init',
      name: 'NotificationIsolationFuzzInit',
      description: `All ${N} clients initialize successfully`,
      status: 'SUCCESS',
      timestamp,
      specReferences: SPEC_REFERENCES,
      details: {
        clientCount: N,
        sessionsWithIds: sessions.filter((s) => s.sessionId).length,
        sessionsWithoutIds: sessions.filter((s) => !s.sessionId).length
      }
    });

    // -- Step 2: Fire N concurrent tool calls with unique progress tokens --

    try {
      // Build requests — each with a unique progressToken and the same
      // message ID to maximize collision potential
      const requests = sessions.map((sess) => ({
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'test_tool_with_progress',
            arguments: {},
            _meta: { progressToken: `fuzz-client-${sess.index}` }
          }
        },
        sessionId: sess.sessionId,
        index: sess.index
      }));

      // Fire all requests concurrently (small stagger to create realistic
      // interleaving, but fast enough to overlap handler execution)
      const streamPromises: Array<
        Promise<{ index: number; stream: SSEStreamResult }>
      > = [];

      for (const req of requests) {
        const promise = (async () => {
          const raw = await sendJsonRpcRequestRaw(
            serverUrl,
            req.body,
            req.sessionId
          );
          const stream = await parseSSEStreamFull(raw, 8000);
          return { index: req.index, stream };
        })();
        streamPromises.push(promise);
        // Tiny stagger (5ms) to create realistic interleaving
        await new Promise((r) => setTimeout(r, 5));
      }

      const results = await Promise.all(streamPromises);

      // -- Analyze results --

      let totalLeaks = 0;
      let totalMissingResponses = 0;
      let totalCorrectNotifications = 0;
      const leakDetails: Array<{
        clientIndex: number;
        expectedToken: string;
        foreignTokensReceived: string[];
      }> = [];

      for (const { index, stream } of results) {
        const expectedToken = `fuzz-client-${index}`;
        const progressTokens = stream.notifications
          .filter((n) => n.method === 'notifications/progress')
          .map((n) => n.params?.progressToken);

        const ownTokens = progressTokens.filter((t) => t === expectedToken);
        const foreignTokens = progressTokens.filter(
          (t) => t !== expectedToken && t !== undefined
        );

        if (foreignTokens.length > 0) {
          totalLeaks++;
          leakDetails.push({
            clientIndex: index,
            expectedToken,
            foreignTokensReceived: foreignTokens
          });
        }

        if (ownTokens.length > 0) {
          totalCorrectNotifications++;
        }

        if (!stream.response) {
          totalMissingResponses++;
        }
      }

      const passed = totalLeaks === 0 && totalMissingResponses === 0;

      const errors: string[] = [];
      if (totalLeaks > 0) {
        errors.push(
          `${totalLeaks}/${N} clients received foreign progress notifications (cross-talk detected)`
        );
      }
      if (totalMissingResponses > 0) {
        errors.push(
          `${totalMissingResponses}/${N} clients did not receive a final response`
        );
      }

      checks.push({
        id: 'notification-isolation-fuzz',
        name: 'NotificationIsolationFuzz',
        description: `${N} concurrent clients all receive correctly routed notifications`,
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        details: {
          clientCount: N,
          clientsWithCorrectNotifications: totalCorrectNotifications,
          clientsWithLeaks: totalLeaks,
          clientsMissingResponse: totalMissingResponses,
          ...(leakDetails.length > 0 ? { leakDetails } : {})
        },
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined
      });
    } catch (error) {
      checks.push({
        id: 'notification-isolation-fuzz',
        name: 'NotificationIsolationFuzz',
        description: `${N} concurrent clients all receive correctly routed notifications`,
        status: 'FAILURE',
        timestamp,
        specReferences: SPEC_REFERENCES,
        errorMessage: `Error: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    return checks;
  }
}
