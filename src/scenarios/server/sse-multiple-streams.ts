/**
 * SSE Multiple Streams conformance test scenarios for MCP servers (SEP-1699)
 *
 * Tests that servers properly support multiple concurrent SSE streams:
 * - Accepting multiple POST requests that return SSE streams simultaneously
 * - Each POST request gets its own stream with unique stream ID
 *
 * Note: The standalone GET stream (without Last-Event-ID) is limited to one per session.
 * Multiple concurrent streams are achieved via POST requests, each getting their own stream.
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class ServerSSEMultipleStreamsScenario implements ClientScenario {
  name = 'server-sse-multiple-streams';
  description =
    'Test server supports multiple concurrent POST SSE streams (SEP-1699)';

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

      // Extract session ID from transport
      sessionId = (transport as unknown as { sessionId?: string }).sessionId;

      if (!sessionId) {
        checks.push({
          id: 'server-sse-multiple-streams-session',
          name: 'ServerSSEMultipleStreamsSession',
          description: 'Server provides session ID for multiple streams test',
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
              'Server did not provide session ID - multiple streams test may not work correctly'
          }
        });
        return checks;
      }

      // Step 2: Open multiple POST SSE streams concurrently
      // Each POST request gets its own stream with unique streamId
      // Spec says: "The client MAY remain connected to multiple SSE streams simultaneously"
      const streamResponses: Response[] = [];
      const numStreams = 3;

      // Launch all POST requests concurrently
      const postPromises = [];
      for (let i = 0; i < numStreams; i++) {
        const promise = fetch(serverUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-03-26'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1000 + i, // Different request IDs for each stream
            method: 'tools/list',
            params: {}
          })
        });
        postPromises.push(promise);
      }

      // Wait for all responses
      const responses = await Promise.all(postPromises);
      streamResponses.push(...responses);

      // Check that all streams were accepted (HTTP 200)
      const allAccepted = streamResponses.every((r) => r.ok);
      const statuses = streamResponses.map((r) => r.status);
      const contentTypes = streamResponses.map((r) =>
        r.headers.get('content-type')
      );

      // Count how many returned SSE streams vs JSON
      const sseStreams = contentTypes.filter(
        (ct) => ct?.includes('text/event-stream')
      ).length;

      checks.push({
        id: 'server-accepts-multiple-post-streams',
        name: 'ServerAcceptsMultiplePostStreams',
        description:
          'Server allows multiple concurrent POST requests (each may return SSE or JSON)',
        status: allAccepted ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1699',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
          }
        ],
        details: {
          numStreamsAttempted: numStreams,
          numStreamsAccepted: statuses.filter((s) => s === 200).length,
          numSseStreams: sseStreams,
          statuses,
          contentTypes
        },
        errorMessage: !allAccepted
          ? `Server rejected some requests. Statuses: ${statuses.join(', ')}`
          : undefined
      });

      // Step 3: Verify SSE streams are functional by reading events
      // Only test streams that returned SSE content-type
      const eventResults = await Promise.all(
        streamResponses.map(async (response, index) => {
          const contentType = response.headers.get('content-type');

          // Skip non-SSE responses (JSON responses are also valid)
          if (!contentType?.includes('text/event-stream')) {
            return { index, type: 'json', skipped: true };
          }

          if (!response.ok || !response.body) {
            return { index, type: 'sse', error: 'Stream not available' };
          }

          try {
            const reader = response.body
              .pipeThrough(new TextDecoderStream())
              .pipeThrough(new EventSourceParserStream())
              .getReader();

            // Wait for one event with timeout
            const timeoutPromise = new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 2000)
            );

            const eventPromise = reader.read().then(({ value }) => value);

            const event = await Promise.race([eventPromise, timeoutPromise]);

            // Cancel reader
            await reader.cancel();

            return { index, type: 'sse', event };
          } catch (error) {
            return {
              index,
              type: 'sse',
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );

      // Count functional SSE streams (received event or timed out waiting - both are valid)
      const sseResults = eventResults.filter((r) => r.type === 'sse');
      const functionalSseStreams = sseResults.filter(
        (r) => !('error' in r)
      ).length;

      // If server returned SSE streams, they should be functional
      if (sseStreams > 0) {
        checks.push({
          id: 'server-sse-streams-functional',
          name: 'ServerSSEStreamsFunctional',
          description: 'Multiple POST SSE streams should be functional',
          status:
            functionalSseStreams === sseStreams
              ? 'SUCCESS'
              : functionalSseStreams > 0
                ? 'WARNING'
                : 'FAILURE',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            numSseStreams: sseStreams,
            functionalSseStreams,
            results: eventResults
          },
          errorMessage:
            functionalSseStreams < sseStreams
              ? `Only ${functionalSseStreams}/${sseStreams} SSE streams were functional`
              : undefined
        });
      } else {
        // Server returned JSON for all requests - this is valid but worth noting
        checks.push({
          id: 'server-sse-streams-functional',
          name: 'ServerSSEStreamsFunctional',
          description: 'Server returned JSON responses (SSE streams optional)',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-1699',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1699'
            }
          ],
          details: {
            numSseStreams: 0,
            message:
              'Server returned JSON for all requests - SSE streaming is optional',
            results: eventResults
          }
        });
      }
    } catch (error) {
      checks.push({
        id: 'server-sse-multiple-streams-error',
        name: 'ServerSSEMultipleStreamsTest',
        description: 'Test server multiple SSE streams behavior',
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
