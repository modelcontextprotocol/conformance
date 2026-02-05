/**
 * Session Isolation conformance test scenario for MCP servers
 *
 * Tests that servers correctly isolate responses between two concurrent clients
 * when their JSON-RPC message IDs collide. This validates protection against
 * CWE-362 (Concurrent Execution using Shared Resource with Improper Synchronization)
 * where a shared StreamableHTTPServerTransport without session management can
 * route responses to the wrong client.
 *
 * See: ./mcp-session-issue.md for the full vulnerability report.
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
      const responseAPromise = sendJsonRpcRequest(serverUrl, textToolRequest, sessionIdA);
      await new Promise((r) => setTimeout(r, 100));
      const responseBPromise = sendJsonRpcRequest(serverUrl, imageToolRequest, sessionIdB);

      // Wait for B first (fast tool). If B got the wrong content type,
      // A's response was stolen — no point waiting for A at all.
      const responseB = await responseBPromise;
      const bContentType = responseB.jsonRpcResponse?.result?.content?.[0]?.type;
      const bCorrect = bContentType === 'image';

      const responseA = bCorrect
        ? await Promise.race([
            responseAPromise,
            // If A hasn't resolved 200ms after B, it's not coming
            new Promise<{ status: number; headers: Headers; jsonRpcResponse: any }>((resolve) =>
              setTimeout(() => resolve({ status: 0, headers: new Headers(), jsonRpcResponse: null }), 200)
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
