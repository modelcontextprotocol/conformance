/**
 * SSE Polling conformance test scenarios for MCP servers (SEP-1699)
 *
 * Tests that servers properly implement SSE polling behavior including:
 * - Sending priming events with event ID and empty data on POST SSE streams
 * - Sending retry field in priming events when configured
 * - Replaying events when client reconnects with Last-Event-ID
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class ServerSSEPollingScenario implements ClientScenario {
  name = 'server-sse-polling';
  description =
    'Test server sends SSE priming events on POST streams and supports event replay (SEP-1699)';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let sessionId: string | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;

    try {
      // Step 1: Initialize session with the server
      client = new Client(
        {
          name: 'conformance-test-client',
          version: '1.0.0'
        },
        {
          capabilities: {
            sampling: {},
            elicitation: {}
          }
        }
      );

      transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      await client.connect(transport);

      // Extract session ID from transport (accessing internal state)
      sessionId = (transport as unknown as { sessionId?: string }).sessionId;

      if (!sessionId) {
        checks.push({
          id: 'server-sse-polling-session',
          name: 'ServerSSEPollingSession',
          description: 'Server provides session ID for SSE polling tests',
          status: 'WARNING',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            message:
              'Server did not provide session ID - SSE polling tests may not work correctly'
          }
        });
      }

      // Step 2: Make a POST request that returns SSE stream
      // We need to use raw fetch to observe the priming event
      const postResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...(sessionId && { 'mcp-session-id': sessionId }),
          'mcp-protocol-version': '2025-03-26'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        })
      });

      if (!postResponse.ok) {
        checks.push({
          id: 'server-sse-post-request',
          name: 'ServerSSEPostRequest',
          description: 'Server accepts POST request with SSE stream response',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Server returned HTTP ${postResponse.status}`,
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ]
        });
        return checks;
      }

      // Check if server returned SSE stream
      const contentType = postResponse.headers.get('content-type');
      if (!contentType?.includes('text/event-stream')) {
        checks.push({
          id: 'server-sse-content-type',
          name: 'ServerSSEContentType',
          description: 'Server returns text/event-stream for POST request',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            contentType,
            message:
              'Server returned JSON instead of SSE stream - priming event tests not applicable'
          }
        });
        return checks;
      }

      // Step 3: Parse SSE stream for priming event
      let hasEventId = false;
      let hasPrimingEvent = false;
      let primingEventIsFirst = false;
      let hasRetryField = false;
      let retryValue: number | undefined;
      let primingEventId: string | undefined;
      let eventCount = 0;

      if (!postResponse.body) {
        checks.push({
          id: 'server-sse-polling-stream',
          name: 'ServerSSEPollingStream',
          description: 'Server provides SSE response body',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Response body is null',
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ]
        });
        return checks;
      }

      const reader = postResponse.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(
          new EventSourceParserStream({
            onRetry: (retryMs: number) => {
              hasRetryField = true;
              retryValue = retryMs;
            }
          })
        )
        .getReader();

      // Read events with timeout
      const timeout = setTimeout(() => {
        reader.cancel();
      }, 5000);

      try {
        while (true) {
          const { value: event, done } = await reader.read();

          if (done) {
            break;
          }

          eventCount++;

          // Check for event ID
          if (event.id) {
            hasEventId = true;
            if (!primingEventId) {
              primingEventId = event.id;
            }

            // Check if this is a priming event (empty or minimal data)
            if (
              event.data === '' ||
              event.data === '{}' ||
              event.data.trim() === ''
            ) {
              hasPrimingEvent = true;
              // Check if priming event is the first event
              if (eventCount === 1) {
                primingEventIsFirst = true;
              }
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // Check 1: Server SHOULD send priming event with ID on POST SSE stream
      let primingStatus: 'SUCCESS' | 'WARNING' = 'SUCCESS';
      let primingErrorMessage: string | undefined;

      if (!hasPrimingEvent) {
        primingStatus = 'WARNING';
        primingErrorMessage =
          'Server did not send priming event with id and empty data on POST SSE stream. This is recommended for resumability.';
      } else if (!primingEventIsFirst) {
        primingStatus = 'WARNING';
        primingErrorMessage =
          'Priming event was not sent first. It should be sent immediately when the SSE stream is established.';
      }

      checks.push({
        id: 'server-sse-priming-event',
        name: 'ServerSendsPrimingEvent',
        description:
          'Server SHOULD send priming event with id and empty data on POST SSE streams',
        status: primingStatus,
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          hasPrimingEvent,
          primingEventIsFirst,
          hasEventId,
          primingEventId,
          eventCount
        },
        errorMessage: primingErrorMessage
      });

      // Check 2: Server SHOULD send retry field in priming event
      checks.push({
        id: 'server-sse-retry-field',
        name: 'ServerSendsRetryField',
        description:
          'Server SHOULD send retry field to control client reconnection timing',
        status: hasRetryField ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          hasRetryField,
          retryValue
        },
        errorMessage: !hasRetryField
          ? 'Server did not send retry field. This is recommended for controlling client reconnection timing.'
          : undefined
      });

      // Step 4: Test event replay by reconnecting with Last-Event-ID
      if (primingEventId && sessionId) {
        // Make a GET request with Last-Event-ID to test replay
        const getResponse = await fetch(serverUrl, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-03-26',
            'last-event-id': primingEventId
          }
        });

        if (getResponse.ok) {
          // Server accepted reconnection with Last-Event-ID
          let replayedEvents = 0;

          if (getResponse.body) {
            const replayReader = getResponse.body
              .pipeThrough(new TextDecoderStream())
              .pipeThrough(new EventSourceParserStream())
              .getReader();

            const replayTimeout = setTimeout(() => {
              replayReader.cancel();
            }, 2000);

            try {
              while (true) {
                const { done } = await replayReader.read();
                if (done) break;
                replayedEvents++;
              }
            } finally {
              clearTimeout(replayTimeout);
            }
          }

          checks.push({
            id: 'server-sse-event-replay',
            name: 'ServerReplaysEvents',
            description:
              'Server replays events after Last-Event-ID on reconnection',
            status: 'SUCCESS',
            timestamp: new Date().toISOString(),
            specReferences: [
              {
                id: 'SEP-1699',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
              }
            ],
            details: {
              lastEventIdUsed: primingEventId,
              replayedEvents,
              message: 'Server accepted GET request with Last-Event-ID header'
            }
          });
        } else {
          // Check if server doesn't support standalone GET streams
          if (getResponse.status === 405) {
            checks.push({
              id: 'server-sse-event-replay',
              name: 'ServerReplaysEvents',
              description:
                'Server supports GET reconnection with Last-Event-ID',
              status: 'INFO',
              timestamp: new Date().toISOString(),
              specReferences: [
                {
                  id: 'SEP-1699',
                  url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
                }
              ],
              details: {
                statusCode: getResponse.status,
                message:
                  'Server does not support standalone GET SSE endpoint (405 Method Not Allowed)'
              }
            });
          } else {
            checks.push({
              id: 'server-sse-event-replay',
              name: 'ServerReplaysEvents',
              description:
                'Server replays events after Last-Event-ID on reconnection',
              status: 'WARNING',
              timestamp: new Date().toISOString(),
              specReferences: [
                {
                  id: 'SEP-1699',
                  url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
                }
              ],
              details: {
                statusCode: getResponse.status,
                lastEventIdUsed: primingEventId,
                message: `Server returned ${getResponse.status} for GET request with Last-Event-ID`
              },
              errorMessage: `Server did not accept reconnection with Last-Event-ID (HTTP ${getResponse.status})`
            });
          }
        }
      } else {
        checks.push({
          id: 'server-sse-event-replay',
          name: 'ServerReplaysEvents',
          description:
            'Server replays events after Last-Event-ID on reconnection',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            primingEventId,
            sessionId,
            message:
              'Could not test event replay - no priming event ID or session ID available'
          }
        });
      }
    } catch (error) {
      checks.push({
        id: 'server-sse-polling-error',
        name: 'ServerSSEPollingTest',
        description: 'Test server SSE polling behavior',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Error: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ]
      });
    } finally {
      // Clean up
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    return checks;
  }
}
