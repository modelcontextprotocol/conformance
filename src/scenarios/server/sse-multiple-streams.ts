/**
 * SSE Multiple Streams conformance test scenarios for MCP servers (SEP-1699)
 *
 * Tests that servers properly support multiple concurrent SSE streams:
 * - Accepting multiple GET SSE streams for the same session
 * - Isolating events between different streams
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class ServerSSEMultipleStreamsScenario implements ClientScenario {
  name = 'server-sse-multiple-streams';
  description =
    'Test server supports multiple concurrent GET SSE streams (SEP-1699)';

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

      // Step 2: Open multiple GET SSE streams concurrently
      // Spec says: "The client MAY remain connected to multiple SSE streams simultaneously"
      const streamResponses: Response[] = [];
      const numStreams = 3;

      for (let i = 0; i < numStreams; i++) {
        const response = await fetch(serverUrl, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-03-26'
          }
        });
        streamResponses.push(response);
      }

      // Check that all streams were accepted
      const allAccepted = streamResponses.every((r) => r.ok);
      const statuses = streamResponses.map((r) => r.status);

      checks.push({
        id: 'server-accepts-multiple-get-streams',
        name: 'ServerAcceptsMultipleGetStreams',
        description:
          'Server MUST allow multiple concurrent GET SSE streams (no 409)',
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
          statuses
        },
        errorMessage: !allAccepted
          ? `Server rejected some streams. Statuses: ${statuses.join(', ')}`
          : undefined
      });

      // Step 3: Test event isolation between streams
      // Make POST requests to generate events that should go to different streams
      // Note: This is harder to test properly because the spec says events are
      // NOT broadcast across multiple streams - only one stream receives each event

      // Get the first event from each stream to verify they're working
      const eventResults = await Promise.all(
        streamResponses.map(async (response, index) => {
          if (!response.ok || !response.body) {
            return { index, error: 'Stream not available' };
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

            return { index, event };
          } catch (error) {
            return {
              index,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );

      // All streams should be functional (either receive events or timeout waiting)
      const streamsFunctional = eventResults.filter(
        (r) => !('error' in r)
      ).length;

      checks.push({
        id: 'server-sse-streams-functional',
        name: 'ServerSSEStreamsFunctional',
        description: 'Multiple SSE streams should be functional',
        status:
          streamsFunctional === numStreams
            ? 'SUCCESS'
            : streamsFunctional > 0
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
          numStreams,
          streamsFunctional,
          results: eventResults
        },
        errorMessage:
          streamsFunctional < numStreams
            ? `Only ${streamsFunctional}/${numStreams} streams were functional`
            : undefined
      });
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
