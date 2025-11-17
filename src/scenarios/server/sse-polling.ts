/**
 * SSE Polling conformance test scenarios for MCP servers (SEP-1699)
 *
 * Tests that servers properly implement SSE polling behavior including:
 * - Sending priming events with event ID and empty data
 * - Sending retry field before closing connection
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';

export class ServerSSEPollingScenario implements ClientScenario {
  name = 'server-sse-polling';
  description =
    'Test server sends SSE priming event and retry field (SEP-1699)';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      // Make a GET request to establish SSE stream
      const response = await fetch(serverUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream'
        }
      });

      // Check if server supports SSE GET endpoint
      if (response.status === 405) {
        checks.push({
          id: 'server-sse-polling-endpoint',
          name: 'ServerSSEPollingEndpoint',
          description: 'Server supports SSE GET endpoint',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            serverUrl,
            statusCode: response.status,
            message:
              'Server does not support SSE GET endpoint (405 Method Not Allowed)'
          }
        });
        return checks;
      }

      // Server may require session context for standalone SSE GET
      if (response.status === 400) {
        checks.push({
          id: 'server-sse-polling-endpoint',
          name: 'ServerSSEPollingEndpoint',
          description: 'Server supports SSE GET endpoint',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            serverUrl,
            statusCode: response.status,
            message:
              'Server requires session context for standalone SSE GET endpoint (400 Bad Request)'
          }
        });
        return checks;
      }

      if (!response.ok) {
        checks.push({
          id: 'server-sse-polling-connection',
          name: 'ServerSSEPollingConnection',
          description: 'Server accepts SSE GET request',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Server returned HTTP ${response.status}`,
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ]
        });
        return checks;
      }

      // Parse SSE stream
      let hasEventId = false;
      let hasPrimingEvent = false;
      let primingEventIsFirst = false;
      let hasRetryField = false;
      let retryValue: number | undefined;
      let firstEventId: string | undefined;
      let disconnected = false;
      let eventCount = 0;

      if (!response.body) {
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

      const reader = response.body
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
            disconnected = true;
            break;
          }

          eventCount++;

          // Check for event ID
          if (event.id) {
            hasEventId = true;
            if (!firstEventId) {
              firstEventId = event.id;
            }

            // Check if this is a priming event (empty or minimal data)
            if (
              event.data === '' ||
              event.data === '{}' ||
              event.data.trim() === ''
            ) {
              hasPrimingEvent = true;
              // Check if priming event is the first event (SEP-1699 says "immediately")
              if (eventCount === 1) {
                primingEventIsFirst = true;
              }
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // Check 1: Server SHOULD send priming event with ID immediately
      let primingStatus: 'SUCCESS' | 'WARNING' = 'SUCCESS';
      let primingErrorMessage: string | undefined;

      if (!hasPrimingEvent) {
        primingStatus = 'WARNING';
        primingErrorMessage =
          'Server did not send priming event with id and empty data. This is a SHOULD requirement for SEP-1699.';
      } else if (!primingEventIsFirst) {
        primingStatus = 'WARNING';
        primingErrorMessage =
          'Priming event was not sent immediately (not the first event). SEP-1699 says server SHOULD immediately send the priming event.';
      }

      checks.push({
        id: 'server-sse-priming-event',
        name: 'ServerSendsPrimingEvent',
        description:
          'Server SHOULD immediately send SSE event with id and empty data to prime client for reconnection',
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
          firstEventId,
          eventCount
        },
        errorMessage: primingErrorMessage
      });

      // Check 2: Server SHOULD send retry field before disconnect
      checks.push({
        id: 'server-sse-retry-field',
        name: 'ServerSendsRetryField',
        description: 'Server SHOULD send retry field before closing connection',
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
          retryValue,
          disconnected
        },
        errorMessage: !hasRetryField
          ? 'Server did not send retry field. This is a SHOULD requirement for SEP-1699.'
          : undefined
      });

      // Check 3: Server MAY close connection after sending event ID
      // Per SEP-1699, server can only close "if it has sent an SSE event with an event ID"
      let disconnectStatus: 'SUCCESS' | 'WARNING' | 'INFO' = 'INFO';
      let disconnectMessage: string | undefined;

      if (disconnected && !hasEventId) {
        disconnectStatus = 'WARNING';
        disconnectMessage =
          'Server closed connection without sending an event ID first. SEP-1699 allows disconnect only after sending event ID.';
      }

      checks.push({
        id: 'server-sse-disconnect',
        name: 'ServerDisconnectBehavior',
        description:
          'Server MAY close connection after sending event ID (informational)',
        status: disconnectStatus,
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          disconnected,
          hasEventId,
          eventCount,
          hasRetryField,
          retryValue
        },
        errorMessage: disconnectMessage
      });
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
    }

    return checks;
  }
}
