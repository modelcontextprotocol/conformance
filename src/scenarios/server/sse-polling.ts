/**
 * SSE Polling conformance test scenarios for MCP servers (SEP-1699)
 *
 * Tests that servers properly implement SSE polling behavior including:
 * - Sending priming events with event ID and empty data on POST SSE streams
 * - Sending retry field in priming events when configured
 * - Closing SSE stream mid-operation and resuming after client reconnects
 * - Replaying events when client reconnects with Last-Event-ID
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function createLoggingFetch(checks: ConformanceCheck[]) {
  return async (url: string, options: RequestInit): Promise<Response> => {
    const method = options.method || 'GET';
    let description = `Sending ${method} request`;
    if (options.body) {
      try {
        const body = JSON.parse(options.body as string);
        if (body.method) {
          description = `Sending ${method} ${body.method}`;
        }
      } catch {
        // Not JSON
      }
    }

    checks.push({
      id: 'outgoing-request',
      name: 'OutgoingRequest',
      description,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        method,
        url,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body as string) : undefined
      }
    });

    const response = await fetch(url, options);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    checks.push({
      id: 'incoming-response',
      name: 'IncomingResponse',
      description: `Received ${response.status} response for ${method}`,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: {
        statusCode: response.status,
        headers: responseHeaders
      }
    });

    return response;
  };
}

export class ServerSSEPollingScenario implements ClientScenario {
  name = 'server-sse-polling';
  description =
    'Test server SSE polling via test_reconnection tool that closes stream mid-call (SEP-1699)';

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

      // Step 2: Call test_reconnection tool via raw fetch to observe SSE behavior
      // This tool should close the stream mid-call, requiring reconnection
      const loggingFetch = createLoggingFetch(checks);

      const postResponse = await loggingFetch(serverUrl, {
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
          method: 'tools/call',
          params: {
            name: 'test_reconnection',
            arguments: {}
          }
        })
      });

      if (!postResponse.ok) {
        // Check if tool doesn't exist (method not found or similar)
        if (postResponse.status === 400 || postResponse.status === 404) {
          checks.push({
            id: 'server-sse-test-reconnection-tool',
            name: 'ServerTestReconnectionTool',
            description:
              'Server implements test_reconnection tool for SSE polling tests',
            status: 'WARNING',
            timestamp: new Date().toISOString(),
            errorMessage: `Server does not implement test_reconnection tool (HTTP ${postResponse.status}). This tool is recommended for testing SSE polling behavior.`,
            specReferences: [
              {
                id: 'SEP-1699',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
              }
            ]
          });
          return checks;
        }

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

      // Step 3: Parse SSE stream for priming event and tool response
      let hasEventId = false;
      let hasPrimingEvent = false;
      let primingEventIsFirst = false;
      let hasRetryField = false;
      let retryValue: number | undefined;
      let lastEventId: string | undefined;
      let eventCount = 0;
      let receivedToolResponse = false;

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

      // Read events with timeout - expect stream to close before we get the response
      const timeout = setTimeout(() => {
        reader.cancel();
      }, 10000);

      try {
        while (true) {
          const { value: event, done } = await reader.read();

          if (done) {
            break;
          }

          eventCount++;

          // Track the last event ID for reconnection
          if (event.id) {
            hasEventId = true;
            lastEventId = event.id;

            // Check if this is a priming event (empty or minimal data)
            const isPriming =
              event.data === '' ||
              event.data === '{}' ||
              event.data.trim() === '';
            if (isPriming) {
              hasPrimingEvent = true;
              // Check if priming event is the first event
              if (eventCount === 1) {
                primingEventIsFirst = true;
              }
            }

            // Log the SSE event
            checks.push({
              id: 'incoming-sse-event',
              name: 'IncomingSseEvent',
              description: isPriming
                ? `Received SSE priming event (id: ${event.id})`
                : `Received SSE event (id: ${event.id})`,
              status: 'INFO',
              timestamp: new Date().toISOString(),
              details: {
                eventId: event.id,
                eventType: event.event || 'message',
                isPriming,
                hasRetryField,
                retryValue,
                data: event.data
              }
            });
          }

          // Check if this is the tool response
          if (event.data) {
            try {
              const parsed = JSON.parse(event.data);
              if (parsed.id === 1 && parsed.result) {
                receivedToolResponse = true;
                const isError = parsed.result?.isError === true;
                checks.push({
                  id: 'incoming-sse-event',
                  name: 'IncomingSseEvent',
                  description: `Received tool response on POST stream`,
                  status: isError ? 'FAILURE' : 'INFO',
                  timestamp: new Date().toISOString(),
                  details: {
                    eventId: event.id,
                    body: parsed
                  },
                  ...(isError && { errorMessage: `Tool call failed` })
                });
              }
            } catch {
              // Not JSON, ignore
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // Log stream closure
      checks.push({
        id: 'stream-closed',
        name: 'StreamClosed',
        description: `POST SSE stream closed after ${eventCount} event(s)`,
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: {
          eventCount,
          lastEventId,
          receivedToolResponse
        }
      });

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
          lastEventId,
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

      // Step 4: If tool response wasn't received, reconnect with Last-Event-ID
      if (!receivedToolResponse && lastEventId && sessionId) {
        // Make a GET request with Last-Event-ID to get the tool response
        const getResponse = await loggingFetch(serverUrl, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-03-26',
            'last-event-id': lastEventId
          }
        });

        if (getResponse.ok && getResponse.body) {
          const reconnectReader = getResponse.body
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream())
            .getReader();

          const reconnectTimeout = setTimeout(() => {
            reconnectReader.cancel();
          }, 5000);

          try {
            while (true) {
              const { value: event, done } = await reconnectReader.read();
              if (done) break;

              // Log each event received on GET stream
              checks.push({
                id: 'incoming-sse-event',
                name: 'IncomingSseEvent',
                description: `Received SSE event on GET reconnection stream (id: ${event.id || 'none'})`,
                status: 'INFO',
                timestamp: new Date().toISOString(),
                details: {
                  eventId: event.id,
                  eventType: event.event || 'message',
                  data: event.data
                }
              });

              // Check if this is the tool response
              if (event.data) {
                try {
                  const parsed = JSON.parse(event.data);
                  if (parsed.id === 1 && parsed.result) {
                    receivedToolResponse = true;
                    break;
                  }
                } catch {
                  // Not JSON, ignore
                }
              }
            }
          } finally {
            clearTimeout(reconnectTimeout);
          }

          checks.push({
            id: 'server-sse-disconnect-resume',
            name: 'ServerDisconnectResume',
            description:
              'Server closes SSE stream mid-call and resumes after client reconnects with Last-Event-ID',
            status: receivedToolResponse ? 'SUCCESS' : 'WARNING',
            timestamp: new Date().toISOString(),
            specReferences: [
              {
                id: 'SEP-1699',
                url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
              }
            ],
            details: {
              lastEventIdUsed: lastEventId,
              receivedToolResponse,
              message: receivedToolResponse
                ? 'Successfully received tool response after reconnection'
                : 'Tool response not received after reconnection'
            },
            errorMessage: !receivedToolResponse
              ? 'Server did not send tool response after client reconnected with Last-Event-ID'
              : undefined
          });
        } else {
          // Check if server doesn't support standalone GET streams
          if (getResponse.status === 405) {
            checks.push({
              id: 'server-sse-disconnect-resume',
              name: 'ServerDisconnectResume',
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
              id: 'server-sse-disconnect-resume',
              name: 'ServerDisconnectResume',
              description:
                'Server supports GET reconnection with Last-Event-ID',
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
                lastEventIdUsed: lastEventId,
                message: `Server returned ${getResponse.status} for GET request with Last-Event-ID`
              },
              errorMessage: `Server did not accept reconnection with Last-Event-ID (HTTP ${getResponse.status})`
            });
          }
        }
      } else if (receivedToolResponse) {
        // Tool response was received on the initial POST stream (server didn't disconnect)
        checks.push({
          id: 'server-sse-disconnect-resume',
          name: 'ServerDisconnectResume',
          description:
            'Server closes SSE stream mid-call and resumes after reconnection',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            receivedToolResponse: true,
            message:
              'Tool response received on initial POST stream - server did not disconnect mid-call. The test_reconnection tool should close the stream before sending the result.'
          }
        });
      } else {
        checks.push({
          id: 'server-sse-disconnect-resume',
          name: 'ServerDisconnectResume',
          description:
            'Server closes SSE stream mid-call and resumes after reconnection',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            lastEventId,
            sessionId,
            message:
              'Could not test disconnect/resume - no last event ID or session ID available'
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
