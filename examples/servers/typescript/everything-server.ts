#!/usr/bin/env node

/**
 * MCP Everything Server - Conformance Test Server
 *
 * Server implementing all MCP features for conformance testing based on Conformnace Server Specification.
 * Should be using registerTool(), registerResource(), and registerPrompt().
 * we use tool() instead of registerTool() as there is a bug with logging in registerTool().
 */

import {
  McpServer,
  ResourceTemplate
} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport,
  EventStore,
  EventId,
  StreamId
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  ElicitResultSchema,
  ResultSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  type ListToolsResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import cors from 'cors';
import { randomUUID, createHmac } from 'crypto';

// Server state
const resourceSubscriptions = new Set<string>();
const watchedResourceContent = 'Watched resource content';

// HMAC-based requestState for SEP-2322 MRTR integrity tests
const MRTR_STATE_SECRET = 'conformance-mrtr-secret-' + randomUUID();

function signMrtState(payload: Record<string, unknown>): string {
  const data = JSON.stringify(payload);
  const hmac = createHmac('sha256', MRTR_STATE_SECRET)
    .update(data)
    .digest('hex');
  return JSON.stringify({ data, hmac });
}

function verifyMrtState(raw: string): Record<string, unknown> | null {
  try {
    const { data, hmac } = JSON.parse(raw) as { data: string; hmac: string };
    const expected = createHmac('sha256', MRTR_STATE_SECRET)
      .update(data)
      .digest('hex');
    if (hmac !== expected) return null;
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getMrtInputText(inputResponse: unknown, field: string): string {
  const content = (inputResponse as Record<string, unknown> | undefined)
    ?.content as Record<string, unknown> | undefined;
  const value = content?.[field];
  return typeof value === 'string' ? value : 'unknown';
}

// Session management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// In-memory client connected to a fully-registered McpServer. Used by the
// stateless POST handler to serve carry-forward methods (tools/call,
// resources/*, prompts/get, completion/complete) without duplicating the
// registrations. The SDK doesn't yet support a stateless server natively,
// so this bridges via the in-memory transport after a one-time initialize.
//
// A fresh server+client pair is built per request so concurrent requests
// can't observe each other's notifications.
type DispatchClient = {
  client: Client;
  drainNotifications: () => unknown[];
  close: () => Promise<void>;
};
async function getStatelessDispatchClient(): Promise<DispatchClient> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverT);
  const client = new Client(
    { name: 'stateless-dispatch', version: '1.0.0' },
    { capabilities: { sampling: {}, elicitation: {} } }
  );
  await client.connect(clientT);

  // Buffer notifications so the stateless handler can flush them to the SSE
  // response after the request completes. The SDK pre-registers a handler for
  // notifications/progress so a fallback alone would miss it.
  const buffer: unknown[] = [];
  const collect = async (n: unknown) =>
    void buffer.push({ jsonrpc: '2.0', ...(n as object) });
  client.setNotificationHandler(ProgressNotificationSchema, collect);
  client.setNotificationHandler(LoggingMessageNotificationSchema, collect);
  client.fallbackNotificationHandler = collect;

  return {
    client,
    drainNotifications: () => buffer.splice(0, buffer.length),
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

// In-memory event store for SEP-1699 resumability
const eventStoreData = new Map<
  string,
  { eventId: string; message: any; streamId: string }
>();

function createEventStore(): EventStore {
  return {
    async storeEvent(streamId: StreamId, message: any): Promise<EventId> {
      const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
      eventStoreData.set(eventId, { eventId, message, streamId });
      return eventId;
    },
    async replayEventsAfter(
      lastEventId: EventId,
      { send }: { send: (eventId: EventId, message: any) => Promise<void> }
    ): Promise<StreamId> {
      const streamId = lastEventId.split('::')[0];
      const eventsToReplay: Array<[string, { message: any }]> = [];
      for (const [eventId, data] of eventStoreData.entries()) {
        if (data.streamId === streamId && eventId > lastEventId) {
          eventsToReplay.push([eventId, data]);
        }
      }
      eventsToReplay.sort(([a], [b]) => a.localeCompare(b));
      for (const [eventId, { message }] of eventsToReplay) {
        if (Object.keys(message).length > 0) {
          await send(eventId, message);
        }
      }
      return streamId;
    }
  };
}

// Sample base64 encoded 1x1 red PNG pixel for testing
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample base64 encoded minimal WAV file for testing
const TEST_AUDIO_BASE64 =
  'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=';

// SEP-1613: Raw JSON Schema 2020-12 definition for conformance testing
// This schema includes $schema, $defs, and additionalProperties to test
// that SDKs correctly preserve these fields
const JSON_SCHEMA_2020_12_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  $defs: {
    address: {
      // SEP-2106: reference keyword ($anchor) must be preserved
      $anchor: 'addressDef',
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' }
      }
    }
  },
  properties: {
    name: { type: 'string' },
    address: { $ref: '#/$defs/address' },
    contactMethod: { type: 'string', enum: ['phone', 'email'] },
    phone: { type: 'string' },
    email: { type: 'string' }
  },
  // SEP-2106: the full JSON Schema 2020-12 vocabulary is permitted in
  // inputSchema (alongside the required root `type: "object"`). These keywords
  // exercise that SDKs preserve them through tools/list rather than stripping
  // them down to properties/required.
  //
  // Composition keywords (allOf / anyOf):
  allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
  // Conditional keywords (if / then / else):
  if: {
    properties: { contactMethod: { const: 'phone' } },
    required: ['contactMethod']
  },
  then: { required: ['phone'] },
  else: { required: ['email'] },
  additionalProperties: false
};

// Function to create a new MCP server instance (one per session)
function createMcpServer() {
  const mcpServer = new McpServer(
    {
      name: 'mcp-conformance-test-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        },
        resources: {
          subscribe: true,
          listChanged: true
        },
        prompts: {
          listChanged: true
        },
        logging: {},
        completions: {}
      }
    }
  );

  // SEP-2549: Wrap setRequestHandler so the SDK's own list handlers
  // automatically get caching hints appended to their responses.
  const originalSetRequestHandler = mcpServer.server.setRequestHandler.bind(
    mcpServer.server
  );
  const listSchemasForCaching = new Set([
    ListToolsRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema
  ]);
  mcpServer.server.setRequestHandler = ((schema: any, handler: any) => {
    if (listSchemasForCaching.has(schema)) {
      return originalSetRequestHandler(schema, async (...args: any[]) => {
        const result = await handler(...args);
        return { ...result, ttlMs: 300000, cacheScope: 'public' as const };
      });
    }
    return originalSetRequestHandler(schema, handler);
  }) as typeof mcpServer.server.setRequestHandler;

  const registerResourceWithCacheHints =
    mcpServer.registerResource.bind(mcpServer);
  mcpServer.registerResource = ((
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    config: any,
    readCallback: any
  ) =>
    registerResourceWithCacheHints(
      name,
      uriOrTemplate as any,
      config,
      async (...args: any[]) => ({
        ...(await readCallback(...args)),
        ttlMs: 300000,
        cacheScope: 'private' as const
      })
    )) as typeof mcpServer.registerResource;

  // Helper to send log messages using the underlying server
  function sendLog(
    level:
      | 'debug'
      | 'info'
      | 'notice'
      | 'warning'
      | 'error'
      | 'critical'
      | 'alert'
      | 'emergency',
    message: string,
    data?: any
  ) {
    mcpServer.server
      .notification({
        method: 'notifications/message',
        params: {
          level,
          logger: 'conformance-test-server',
          data: data || message
        }
      })
      .catch(() => {
        // Ignore error if no client is connected
      });
  }

  // ===== TOOLS =====

  // Simple text tool
  mcpServer.tool(
    'test_simple_text',
    'Tests simple text content response',
    {},
    async () => {
      return {
        content: [
          { type: 'text', text: 'This is a simple text response for testing.' }
        ]
      };
    }
  );

  // Image content tool
  mcpServer.registerTool(
    'test_image_content',
    {
      description: 'Tests image content response'
    },
    async () => {
      return {
        content: [
          { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }
        ]
      };
    }
  );

  // Audio content tool
  mcpServer.registerTool(
    'test_audio_content',
    {
      description: 'Tests audio content response'
    },
    async () => {
      return {
        content: [
          { type: 'audio', data: TEST_AUDIO_BASE64, mimeType: 'audio/wav' }
        ]
      };
    }
  );

  // Embedded resource tool
  mcpServer.registerTool(
    'test_embedded_resource',
    {
      description: 'Tests embedded resource content response'
    },
    async () => {
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'test://embedded-resource',
              mimeType: 'text/plain',
              text: 'This is an embedded resource content.'
            }
          }
        ]
      };
    }
  );

  // Multiple content types tool
  mcpServer.registerTool(
    'test_multiple_content_types',
    {
      description:
        'Tests response with multiple content types (text, image, resource)'
    },
    async () => {
      return {
        content: [
          { type: 'text', text: 'Multiple content types test:' },
          { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' },
          {
            type: 'resource',
            resource: {
              uri: 'test://mixed-content-resource',
              mimeType: 'application/json',
              text: JSON.stringify({ test: 'data', value: 123 })
            }
          }
        ]
      };
    }
  );

  // Tool with logging - registerTool with empty inputSchema to get (args, extra) signature
  mcpServer.registerTool(
    'test_tool_with_logging',
    {
      description: 'Tests tool that emits log messages during execution',
      inputSchema: {} // Empty schema so callback gets (args, extra) instead of just (extra)
    },
    async (_args, { sendNotification }) => {
      await sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: 'Tool execution started'
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: 'Tool processing data'
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: 'Tool execution completed'
        }
      });
      return {
        content: [
          { type: 'text', text: 'Tool with logging executed successfully' }
        ]
      };
    }
  );

  // Tool with progress - registerTool with empty inputSchema to get (args, extra) signature
  mcpServer.registerTool(
    'test_tool_with_progress',
    {
      description: 'Tests tool that reports progress notifications',
      inputSchema: {} // Empty schema so callback gets (args, extra) instead of just (extra)
    },
    async (_args, { sendNotification, _meta }) => {
      const progressToken = _meta?.progressToken ?? 0;
      console.log('???? Progress token:', progressToken);
      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: 0,
          total: 100,
          message: `Completed step ${0} of ${100}`
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: 50,
          total: 100,
          message: `Completed step ${50} of ${100}`
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: 100,
          total: 100,
          message: `Completed step ${100} of ${100}`
        }
      });

      return {
        content: [{ type: 'text', text: String(progressToken) }]
      };
    }
  );

  // Error handling tool
  mcpServer.registerTool(
    'test_error_handling',
    {
      description: 'Tests error response handling'
    },
    async () => {
      throw new Error('This tool intentionally returns an error for testing');
    }
  );

  // SEP-1699: Reconnection test tool - closes SSE stream mid-call to test client reconnection
  mcpServer.registerTool(
    'test_reconnection',
    {
      description:
        'Tests SSE stream disconnection and client reconnection (SEP-1699). Server will close the stream mid-call and send the result after client reconnects.',
      inputSchema: {}
    },
    async (_args, { sessionId, requestId }) => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      console.log(`[${sessionId}] Starting test_reconnection tool...`);

      // Get the transport for this session
      const transport = sessionId ? transports[sessionId] : undefined;
      if (transport && requestId) {
        // Close the SSE stream to trigger client reconnection
        console.log(
          `[${sessionId}] Closing SSE stream to trigger client polling...`
        );
        transport.closeSSEStream(requestId);
      }

      // Wait for client to reconnect (should respect retry field)
      await sleep(100);

      console.log(`[${sessionId}] test_reconnection tool complete`);

      return {
        content: [
          {
            type: 'text',
            text: 'Reconnection test completed successfully. If you received this, the client properly reconnected after stream closure.'
          }
        ]
      };
    }
  );

  // Sampling tool - requests LLM completion from client
  mcpServer.registerTool(
    'test_sampling',
    {
      description: 'Tests server-initiated sampling (LLM completion request)',
      inputSchema: {
        prompt: z.string().describe('The prompt to send to the LLM')
      }
    },
    async (args: { prompt: string }) => {
      try {
        // Request sampling from client
        const result = await mcpServer.server.request(
          {
            method: 'sampling/createMessage',
            params: {
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: args.prompt
                  }
                }
              ],
              maxTokens: 100
            }
          },
          z
            .object({ method: z.literal('sampling/createMessage') })
            .passthrough() as any
        );

        const samplingResult = result as any;
        const modelResponse =
          samplingResult.content?.text ||
          samplingResult.message?.content?.text ||
          'No response';

        return {
          content: [
            {
              type: 'text',
              text: `LLM response: ${modelResponse}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Sampling not supported or error: ${error.message}`
            }
          ]
        };
      }
    }
  );

  // Elicitation tool - requests user input from client
  mcpServer.registerTool(
    'test_elicitation',
    {
      description: 'Tests server-initiated elicitation (user input request)',
      inputSchema: {
        message: z.string().describe('The message to show the user')
      }
    },
    async (args: { message: string }) => {
      try {
        // Request user input from client
        const result = await mcpServer.server.request(
          {
            method: 'elicitation/create',
            params: {
              message: args.message,
              requestedSchema: {
                type: 'object',
                properties: {
                  response: {
                    type: 'string',
                    description: "User's response"
                  }
                },
                required: ['response']
              }
            }
          },
          ElicitResultSchema
        );

        const elicitResult = result as any;
        return {
          content: [
            {
              type: 'text',
              text: `User response: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Elicitation not supported or error: ${error.message}`
            }
          ]
        };
      }
    }
  );

  // SEP-1034: Elicitation with default values for all primitive types
  mcpServer.registerTool(
    'test_elicitation_sep1034_defaults',
    {
      description: 'Tests elicitation with default values per SEP-1034',
      inputSchema: {}
    },
    async () => {
      try {
        // Request user input with default values for all primitive types
        const result = await mcpServer.server.request(
          {
            method: 'elicitation/create',
            params: {
              message: 'Please review and update the form fields with defaults',
              requestedSchema: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'User name',
                    default: 'John Doe'
                  },
                  age: {
                    type: 'integer',
                    description: 'User age',
                    default: 30
                  },
                  score: {
                    type: 'number',
                    description: 'User score',
                    default: 95.5
                  },
                  status: {
                    type: 'string',
                    description: 'User status',
                    enum: ['active', 'inactive', 'pending'],
                    default: 'active'
                  },
                  verified: {
                    type: 'boolean',
                    description: 'Verification status',
                    default: true
                  }
                },
                required: []
              }
            }
          },
          ElicitResultSchema
        );

        const elicitResult = result as any;
        return {
          content: [
            {
              type: 'text',
              text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Elicitation not supported or error: ${error.message}`
            }
          ]
        };
      }
    }
  );

  // SEP-1330: Elicitation with enum schema improvements
  mcpServer.registerTool(
    'test_elicitation_sep1330_enums',
    {
      description:
        'Tests elicitation with enum schema improvements per SEP-1330',
      inputSchema: {}
    },
    async () => {
      try {
        // Request user input with all 5 enum schema variants
        const result = await mcpServer.server.request(
          {
            method: 'elicitation/create',
            params: {
              message: 'Please select options from the enum fields',
              requestedSchema: {
                type: 'object',
                properties: {
                  // Untitled single-select enum (basic)
                  untitledSingle: {
                    type: 'string',
                    description: 'Select one option',
                    enum: ['option1', 'option2', 'option3']
                  },
                  // Titled single-select enum (using oneOf with const/title)
                  titledSingle: {
                    type: 'string',
                    description: 'Select one option with titles',
                    oneOf: [
                      { const: 'value1', title: 'First Option' },
                      { const: 'value2', title: 'Second Option' },
                      { const: 'value3', title: 'Third Option' }
                    ]
                  },
                  // Legacy titled enum (using enumNames - deprecated)
                  legacyEnum: {
                    type: 'string',
                    description: 'Select one option (legacy)',
                    enum: ['opt1', 'opt2', 'opt3'],
                    enumNames: ['Option One', 'Option Two', 'Option Three']
                  },
                  // Untitled multi-select enum
                  untitledMulti: {
                    type: 'array',
                    description: 'Select multiple options',
                    minItems: 1,
                    maxItems: 3,
                    items: {
                      type: 'string',
                      enum: ['option1', 'option2', 'option3']
                    }
                  },
                  // Titled multi-select enum (using anyOf with const/title)
                  titledMulti: {
                    type: 'array',
                    description: 'Select multiple options with titles',
                    minItems: 1,
                    maxItems: 3,
                    items: {
                      anyOf: [
                        { const: 'value1', title: 'First Choice' },
                        { const: 'value2', title: 'Second Choice' },
                        { const: 'value3', title: 'Third Choice' }
                      ]
                    }
                  }
                },
                required: []
              }
            }
          },
          ElicitResultSchema
        );

        const elicitResult = result as any;
        return {
          content: [
            {
              type: 'text',
              text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Elicitation not supported or error: ${error.message}`
            }
          ]
        };
      }
    }
  );

  // SEP-1613: JSON Schema 2020-12 conformance test tool
  // This tool is registered with a Zod schema for tools/call validation,
  // but the tools/list handler (below) returns the raw JSON Schema 2020-12
  // definition to test that SDKs preserve $schema, $defs, additionalProperties
  mcpServer.registerTool(
    'json_schema_2020_12_tool',
    {
      description:
        'Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)',
      inputSchema: {
        name: z.string().optional(),
        address: z
          .object({
            street: z.string().optional(),
            city: z.string().optional()
          })
          .optional()
      }
    },
    async (args: {
      name?: string;
      address?: { street?: string; city?: string };
    }) => {
      return {
        content: [
          {
            type: 'text',
            text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}`
          }
        ]
      };
    }
  );

  // Dynamic tool (registered later via timer)

  // ===== RESOURCES =====

  // Static text resource
  mcpServer.registerResource(
    'static-text',
    'test://static-text',
    {
      title: 'Static Text Resource',
      description: 'A static text resource for testing',
      mimeType: 'text/plain'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'test://static-text',
            mimeType: 'text/plain',
            text: 'This is the content of the static text resource.'
          }
        ]
      };
    }
  );

  // Static binary resource
  mcpServer.registerResource(
    'static-binary',
    'test://static-binary',
    {
      title: 'Static Binary Resource',
      description: 'A static binary resource (image) for testing',
      mimeType: 'image/png'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'test://static-binary',
            mimeType: 'image/png',
            blob: TEST_IMAGE_BASE64
          }
        ]
      };
    }
  );

  // Resource template
  mcpServer.registerResource(
    'template',
    new ResourceTemplate('test://template/{id}/data', {
      list: undefined
    }),
    {
      title: 'Resource Template',
      description: 'A resource template with parameter substitution',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const id = variables.id;
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify({
              id,
              templateTest: true,
              data: `Data for ID: ${id}`
            })
          }
        ]
      };
    }
  );

  // Watched resource
  mcpServer.registerResource(
    'watched-resource',
    'test://watched-resource',
    {
      title: 'Watched Resource',
      description: 'A resource that auto-updates every 3 seconds',
      mimeType: 'text/plain'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'test://watched-resource',
            mimeType: 'text/plain',
            text: watchedResourceContent
          }
        ]
      };
    }
  );

  // Subscribe/Unsubscribe handlers
  mcpServer.server.setRequestHandler(
    z.object({ method: z.literal('resources/subscribe') }).passthrough(),
    async (request: any) => {
      const uri = request.params.uri;
      resourceSubscriptions.add(uri);
      sendLog('info', `Subscribed to resource: ${uri}`);
      return {};
    }
  );

  mcpServer.server.setRequestHandler(
    z.object({ method: z.literal('resources/unsubscribe') }).passthrough(),
    async (request: any) => {
      const uri = request.params.uri;
      resourceSubscriptions.delete(uri);
      sendLog('info', `Unsubscribed from resource: ${uri}`);
      return {};
    }
  );

  // ===== PROMPTS =====

  // Simple prompt
  mcpServer.registerPrompt(
    'test_simple_prompt',
    {
      title: 'Simple Test Prompt',
      description: 'A simple prompt without arguments'
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'This is a simple prompt for testing.'
            }
          }
        ]
      };
    }
  );

  // Prompt with arguments
  mcpServer.registerPrompt(
    'test_prompt_with_arguments',
    {
      title: 'Prompt With Arguments',
      description: 'A prompt with required arguments',
      argsSchema: {
        arg1: z.string().describe('First test argument'),
        arg2: z.string().describe('Second test argument')
      }
    },
    async (args) => {
      const { arg1, arg2 } = args;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`
            }
          }
        ]
      };
    }
  );

  // Prompt with embedded resource
  mcpServer.registerPrompt(
    'test_prompt_with_embedded_resource',
    {
      title: 'Prompt With Embedded Resource',
      description: 'A prompt that includes an embedded resource',
      argsSchema: {
        resourceUri: z.string().describe('URI of the resource to embed')
      }
    },
    async (args) => {
      const uri = args.resourceUri;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri,
                mimeType: 'text/plain',
                text: 'Embedded resource content for testing.'
              }
            }
          },
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Please process the embedded resource above.'
            }
          }
        ]
      };
    }
  );

  // Prompt with image
  mcpServer.registerPrompt(
    'test_prompt_with_image',
    {
      title: 'Prompt With Image',
      description: 'A prompt that includes image content'
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'image',
              data: TEST_IMAGE_BASE64,
              mimeType: 'image/png'
            }
          },
          {
            role: 'user',
            content: { type: 'text', text: 'Please analyze the image above.' }
          }
        ]
      };
    }
  );

  // ===== LOGGING =====

  mcpServer.server.setRequestHandler(
    z.object({ method: z.literal('logging/setLevel') }).passthrough(),
    async (request: any) => {
      const level = request.params.level;
      sendLog('info', `Log level set to: ${level}`);
      return {};
    }
  );

  // ===== COMPLETION =====

  mcpServer.server.setRequestHandler(
    z.object({ method: z.literal('completion/complete') }).passthrough(),
    async (_request: any) => {
      // Basic completion support - returns empty array for conformance
      // Real implementations would provide contextual suggestions
      return {
        completion: {
          values: [],
          total: 0,
          hasMore: false
        }
      };
    }
  );

  // ===== SEP-1613: Override tools/list to return raw JSON Schema 2020-12 =====
  // This override is necessary because registerTool converts Zod schemas to
  // JSON Schema without preserving $schema, $defs, and additionalProperties.
  // We need to return the raw JSON Schema for our test tool while using the
  // SDK's conversion for other tools.
  mcpServer.server.setRequestHandler(
    ListToolsRequestSchema,
    (): ListToolsResult => {
      // Access internal registered tools (this is internal SDK API but stable)
      const registeredTools = (mcpServer as any)._registeredTools as Record<
        string,
        {
          enabled: boolean;
          title?: string;
          description?: string;
          inputSchema?: any;
          outputSchema?: any;
          annotations?: any;
          _meta?: any;
        }
      >;

      return {
        tools: Object.entries(registeredTools)
          .filter(([, tool]) => tool.enabled)
          .map(([name, tool]): Tool => {
            // For our SEP-1613 test tool, return raw JSON Schema 2020-12
            if (name === 'json_schema_2020_12_tool') {
              return {
                name,
                description: tool.description,
                inputSchema: JSON_SCHEMA_2020_12_INPUT_SCHEMA
              };
            }

            // For other tools, use the SDK's own JSON Schema conversion
            // which handles zod v3/v4/v4-mini compatibility
            const inputSchema: Tool['inputSchema'] = tool.inputSchema
              ? (toJsonSchemaCompat(tool.inputSchema, {
                  strictUnions: true,
                  pipeStrategy: 'input'
                }) as Tool['inputSchema'])
              : { type: 'object' as const, properties: {} };

            return {
              name,
              title: tool.title,
              description: tool.description,
              inputSchema,
              annotations: tool.annotations,
              _meta: tool._meta
            };
          })
        // Note: SEP-2549 caching hints are added automatically by the
        // setRequestHandler wrapper above
      };
    }
  );

  return mcpServer;
}

// Helper to check if request is an initialize request
function isInitializeRequest(body: any): boolean {
  return body?.method === 'initialize';
}

// ===== EXPRESS APP =====

// Use createMcpExpressApp for DNS rebinding protection on localhost
const app = createMcpExpressApp();

// Open subscriptions/listen streams (SEP-2575). Notifications are delivered
// to whichever streams are open *at the time of the change* and whose filter
// requested that notification type.
interface ListenStream {
  res: import('express').Response;
  subscriptionId: string;
  wantsTools: boolean;
  wantsPrompts: boolean;
}
const activeListenStreams: ListenStream[] = [];

function notifyListenStreams(
  type: 'tools' | 'prompts',
  notificationMethod: string
) {
  for (const stream of activeListenStreams) {
    const wants = type === 'tools' ? stream.wantsTools : stream.wantsPrompts;
    if (!wants) continue;
    stream.res.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: notificationMethod,
        params: {
          _meta: {
            'io.modelcontextprotocol/subscriptionId': stream.subscriptionId
          }
        }
      }) + '\n'
    );
  }
}

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
  cors({
    origin: '*', // Allow all origins
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
  })
);

// Protocol revisions that use the initialize/session lifecycle. The
// per-request `_meta` and header/body validation requirements apply to
// 2026-07-28 and later, not to traffic from these revisions.
const LEGACY_SESSION_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
];

// Handle POST requests - stateful mode
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const reqVersion = req.headers['mcp-protocol-version'] as string | undefined;
  const body = req.body || {};
  const method = body.method;
  const id = body.id ?? null;
  const params = body.params || {};
  const meta = params._meta;
  const metaVersion = meta?.['io.modelcontextprotocol/protocolVersion'];

  // A request that carries no `_meta` and names a legacy session-era revision
  // in the header is legacy traffic; it is served by the session path below
  // instead of being rejected for missing per-request metadata.
  const isLegacySessionEraRequest =
    meta === undefined &&
    reqVersion !== undefined &&
    LEGACY_SESSION_PROTOCOL_VERSIONS.includes(reqVersion);

  if (!sessionId && (reqVersion || meta) && !isLegacySessionEraRequest) {
    // Missing Transport Header Validation Check
    if (!reqVersion) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32020, message: 'Missing MCP-Protocol-Version header' }
      });
    }

    // Per-Request Metadata Integrity Checks (Fields verification).
    // A request missing any required `_meta` field is malformed: -32602 and,
    // on HTTP, status 400 Bad Request.
    if (
      !meta ||
      !meta['io.modelcontextprotocol/protocolVersion'] ||
      !meta['io.modelcontextprotocol/clientInfo'] ||
      !meta['io.modelcontextprotocol/clientCapabilities']
    ) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Invalid params: missing _meta or required fields'
        }
      });
    }

    // Header Mismatch Verification (-32020, HTTP 400)
    if (reqVersion !== metaVersion) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32020,
          message: 'Mismatched MCP-Protocol-Version header'
        }
      });
    }

    // Protocol Version Negotiation Matrix (-32022, HTTP 400)
    if (metaVersion !== '2026-07-28') {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32022,
          message: 'UnsupportedProtocolVersionError',
          data: {
            supported: ['2026-07-28'],
            requested: String(metaVersion)
          }
        }
      });
    }

    // Subscriptions Listening Endpoint Stream Handler (SSE/Chunked Line)
    if (method === 'subscriptions/listen') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked'
      });

      const requestedNotifications = params.notifications || {};
      // The subscription ID matches the JSON-RPC id of the listen request.
      const trackingSubId = String(id ?? 'sub-token-stateless-123');

      const wantsTools = requestedNotifications.toolsListChanged === true;
      const wantsPrompts = requestedNotifications.promptsListChanged === true;

      // First message MUST be notifications/subscriptions/acknowledged carrying tracking token in _meta
      // The `notifications` field echoes the subset of the requested filter the server honors.
      const ackFrame = {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: {
          _meta: { 'io.modelcontextprotocol/subscriptionId': trackingSubId },
          notifications: {
            ...(wantsTools ? { toolsListChanged: true } : {}),
            ...(wantsPrompts ? { promptsListChanged: true } : {})
          }
        }
      };
      res.write(JSON.stringify(ackFrame) + '\n');

      // Keep the stream open and register it so list-changed notifications
      // triggered by later requests are delivered to it. The stream ends when
      // the client disconnects (which is also how the client cancels it).
      const stream: ListenStream = {
        res,
        subscriptionId: trackingSubId,
        wantsTools,
        wantsPrompts
      };
      activeListenStreams.push(stream);
      res.on('close', () => {
        const index = activeListenStreams.indexOf(stream);
        if (index !== -1) activeListenStreams.splice(index, 1);
      });
      return;
    }

    if (method === 'server/discover') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: {
            tools: { listChanged: true }, // Explicitly announce dynamic capabilities matching Section 7 expectations
            prompts: { listChanged: true },
            // resources/list, resources/templates/list and resources/read are
            // served on this path, so the capability must be declared too.
            resources: {}
          },
          serverInfo: { name: 'everything-stateless-server', version: '1.0.0' }
        }
      });
    }

    if (method === 'tools/list') {
      const dispatch = await getStatelessDispatchClient();
      try {
        const fromServer = (await dispatch.client.request(
          { method: 'tools/list', params: {} },
          ResultSchema as any
        )) as { tools: any[]; [k: string]: unknown };
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            ...fromServer,
            tools: [
              ...fromServer.tools,
              {
                name: 'test_missing_capability',
                description: 'Test tool requiring sampling',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_elicitation',
                description:
                  'MRTR: returns InputRequiredResult with elicitation request',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_sampling',
                description:
                  'MRTR: returns InputRequiredResult with sampling request',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_list_roots',
                description:
                  'MRTR: returns InputRequiredResult with roots/list request',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_request_state',
                description:
                  'MRTR: returns InputRequiredResult with requestState',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_multiple_inputs',
                description:
                  'MRTR: returns InputRequiredResult with multiple input requests',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_multi_round',
                description: 'MRTR: multi-round InputRequiredResult workflow',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_tampered_state',
                description: 'MRTR: HMAC-signed requestState integrity test',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_input_required_result_capabilities',
                description:
                  'MRTR: respects client capabilities in inputRequests',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_streaming_elicitation',
                description:
                  'Diagnostic tool validating response progress streams',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'test_logging_tool',
                description: 'Diagnostic logging validator tool',
                inputSchema: { type: 'object', properties: {} }
              }
            ],
            // SEP-2549 caching hints are required on cacheable list results.
            ttlMs: 300000,
            cacheScope: 'public'
          }
        });
      } catch (e: any) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data: e.data }
        });
      } finally {
        await dispatch.close();
      }
    }

    // Mock fallbacks to answer prompts capability matches safely
    if (method === 'prompts/list') {
      const dispatch = await getStatelessDispatchClient();
      try {
        const fromServer = (await dispatch.client.request(
          { method: 'prompts/list', params: {} },
          ResultSchema as any
        )) as { prompts: any[]; [k: string]: unknown };
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            ...fromServer,
            prompts: [
              ...fromServer.prompts,
              {
                name: 'test_input_required_result_prompt',
                description: 'MRTR: prompt that requires elicitation input'
              }
            ],
            ttlMs: 300000,
            cacheScope: 'public'
          }
        });
      } catch (e: any) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data: e.data }
        });
      } finally {
        await dispatch.close();
      }
    }

    // SEP-2322 MRTR: prompts/get handler
    if (method === 'prompts/get') {
      if (params.name === 'test_input_required_result_prompt') {
        const inputResponses = params.inputResponses as
          | Record<string, unknown>
          | undefined;
        if (inputResponses?.['user_context']) {
          const context = getMrtInputText(
            inputResponses['user_context'],
            'context'
          );
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: `Prompt with context: ${context}`
                  }
                }
              ]
            }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              user_context: {
                method: 'elicitation/create',
                params: {
                  message: 'What context should the prompt use?',
                  requestedSchema: {
                    type: 'object',
                    properties: { context: { type: 'string' } },
                    required: ['context']
                  }
                }
              }
            }
          }
        });
      }
    }

    // Resources on the stateless path (SEP-2575): the McpServer-registered
    // resources are merged with the stateless-only resource, mirroring the
    // tools/list and prompts/list handlers above (SEP-2549 hints + SEP-2164
    // errors via the carry-forward dispatch below).
    if (method === 'resources/list') {
      const dispatch = await getStatelessDispatchClient();
      try {
        const fromServer = (await dispatch.client.request(
          { method: 'resources/list', params: {} },
          ResultSchema as any
        )) as { resources: any[]; [k: string]: unknown };
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            ...fromServer,
            resources: [
              ...fromServer.resources,
              {
                uri: 'test://stateless-static-text',
                name: 'Stateless Static Text',
                description: 'A static text resource served on the draft path',
                mimeType: 'text/plain'
              }
            ],
            ttlMs: 300000,
            cacheScope: 'public'
          }
        });
      } catch (e: any) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data: e.data }
        });
      } finally {
        await dispatch.close();
      }
    }

    if (method === 'resources/templates/list') {
      const dispatch = await getStatelessDispatchClient();
      try {
        const fromServer = (await dispatch.client.request(
          { method: 'resources/templates/list', params: {} },
          ResultSchema as any
        )) as { resourceTemplates: any[]; [k: string]: unknown };
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            ...fromServer,
            ttlMs: 300000,
            cacheScope: 'public'
          }
        });
      } catch (e: any) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data: e.data }
        });
      } finally {
        await dispatch.close();
      }
    }

    if (method === 'resources/read') {
      const uri = params.uri as string | undefined;
      if (uri === 'test://stateless-static-text') {
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: 'Static text content from the stateless draft path.'
              }
            ],
            ttlMs: 300000,
            cacheScope: 'private'
          }
        });
      }
      // Other URIs (including unknown ones) fall through to the carry-forward
      // dispatch below, which serves the McpServer-registered resources.
    }

    if (method === 'tools/call') {
      const name = params.name;
      const inputResponses = params.inputResponses as
        | Record<string, unknown>
        | undefined;
      const requestState = params.requestState as string | undefined;

      if (name === 'test_missing_capability') {
        const clientCaps = meta['io.modelcontextprotocol/clientCapabilities'];

        // Missing Required Client Capability Check (-32021, HTTP 400)
        if (!clientCaps?.sampling) {
          return res.status(400).json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32021,
              message: 'MissingRequiredClientCapabilityError',
              data: { requiredCapabilities: ['sampling'] }
            }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Success' }] }
        });
      }

      // ===== SEP-2322 MRTR tools/call handlers =====

      if (name === 'test_input_required_result_elicitation') {
        if (inputResponses?.['user_name']) {
          const userName = getMrtInputText(inputResponses['user_name'], 'name');
          return res.json({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Hello, ${userName}!` }] }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              user_name: {
                method: 'elicitation/create',
                params: {
                  message: 'What is your name?',
                  requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                  }
                }
              }
            }
          }
        });
      }

      if (name === 'test_input_required_result_sampling') {
        if (inputResponses?.['sample_request']) {
          const sample = inputResponses['sample_request'] as Record<
            string,
            unknown
          >;
          const content = sample.content as Record<string, unknown> | undefined;
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Sampling result: ${typeof content?.text === 'string' ? content.text : 'no response'}`
                }
              ]
            }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              sample_request: {
                method: 'sampling/createMessage',
                params: {
                  messages: [
                    {
                      role: 'user',
                      content: {
                        type: 'text',
                        text: 'What is the capital of France?'
                      }
                    }
                  ],
                  maxTokens: 100
                }
              }
            }
          }
        });
      }

      if (name === 'test_input_required_result_list_roots') {
        if (inputResponses?.['roots_request']) {
          const rootsResult = inputResponses['roots_request'] as Record<
            string,
            unknown
          >;
          const roots = Array.isArray(rootsResult.roots)
            ? rootsResult.roots
            : [];
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Found ${roots.length} root(s)` }]
            }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              roots_request: { method: 'roots/list', params: {} }
            }
          }
        });
      }

      if (name === 'test_input_required_result_request_state') {
        if (requestState && inputResponses?.['confirm']) {
          const state = JSON.parse(requestState) as Record<string, unknown>;
          const ok = (inputResponses['confirm'] as Record<string, unknown>)
            ?.content as Record<string, unknown> | undefined;
          if (state.kind === 'request-state' && ok?.ok === true) {
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  { type: 'text', text: 'state-ok: requestState validated' }
                ]
              }
            });
          }
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              confirm: {
                method: 'elicitation/create',
                params: {
                  message: 'Please confirm',
                  requestedSchema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok']
                  }
                }
              }
            },
            requestState: JSON.stringify({
              kind: 'request-state',
              nonce: randomUUID()
            })
          }
        });
      }

      if (name === 'test_input_required_result_multiple_inputs') {
        if (
          requestState &&
          inputResponses?.['user_name'] &&
          inputResponses['greeting'] &&
          inputResponses['client_roots']
        ) {
          const state = JSON.parse(requestState) as Record<string, unknown>;
          if (state.kind === 'multiple-inputs') {
            const userName = getMrtInputText(
              inputResponses['user_name'],
              'name'
            );
            const greetingContent = (
              inputResponses['greeting'] as Record<string, unknown>
            ).content as Record<string, unknown> | undefined;
            const greeting =
              typeof greetingContent?.text === 'string'
                ? greetingContent.text
                : 'Hello there!';
            const rootsResult = inputResponses['client_roots'] as Record<
              string,
              unknown
            >;
            const roots = Array.isArray(rootsResult.roots)
              ? rootsResult.roots
              : [];
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Name: ${userName}; Greeting: ${greeting}; Roots: ${roots.length}`
                  }
                ]
              }
            });
          }
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              user_name: {
                method: 'elicitation/create',
                params: {
                  message: 'What is your name?',
                  requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                  }
                }
              },
              greeting: {
                method: 'sampling/createMessage',
                params: {
                  messages: [
                    {
                      role: 'user',
                      content: { type: 'text', text: 'Generate a greeting' }
                    }
                  ],
                  maxTokens: 50
                }
              },
              client_roots: { method: 'roots/list', params: {} }
            },
            requestState: JSON.stringify({
              kind: 'multiple-inputs',
              nonce: randomUUID()
            })
          }
        });
      }

      if (name === 'test_input_required_result_multi_round') {
        if (!requestState) {
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'input_required',
              inputRequests: {
                step1: {
                  method: 'elicitation/create',
                  params: {
                    message: 'Step 1: What is your name?',
                    requestedSchema: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                      required: ['name']
                    }
                  }
                }
              },
              requestState: JSON.stringify({ round: 1, nonce: randomUUID() })
            }
          });
        }
        const state = JSON.parse(requestState) as Record<string, unknown>;
        if (state.round === 1 && inputResponses?.['step1']) {
          const userName = getMrtInputText(inputResponses['step1'], 'name');
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'input_required',
              inputRequests: {
                step2: {
                  method: 'elicitation/create',
                  params: {
                    message: 'Step 2: What is your favorite color?',
                    requestedSchema: {
                      type: 'object',
                      properties: { color: { type: 'string' } },
                      required: ['color']
                    }
                  }
                }
              },
              requestState: JSON.stringify({
                round: 2,
                name: userName,
                nonce: randomUUID()
              })
            }
          });
        }
        if (state.round === 2 && inputResponses?.['step2']) {
          const userName =
            typeof state.name === 'string' ? state.name : 'friend';
          const color = getMrtInputText(inputResponses['step2'], 'color');
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Multi-round complete for ${userName} who likes ${color}`
                }
              ]
            }
          });
        }
        // Fallback: restart
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              step1: {
                method: 'elicitation/create',
                params: {
                  message: 'Step 1: What is your name?',
                  requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                  }
                }
              }
            },
            requestState: JSON.stringify({ round: 1, nonce: randomUUID() })
          }
        });
      }

      if (name === 'test_input_required_result_tampered_state') {
        if (requestState) {
          const verified = verifyMrtState(requestState);
          if (!verified) {
            return res.json({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'requestState integrity check failed'
              }
            });
          }
          if (verified.kind === 'tamper-test' && inputResponses?.['confirm']) {
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  { type: 'text', text: 'integrity-ok: state verified' }
                ]
              }
            });
          }
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              confirm: {
                method: 'elicitation/create',
                params: {
                  message: 'Please confirm',
                  requestedSchema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok']
                  }
                }
              }
            },
            requestState: signMrtState({
              kind: 'tamper-test',
              nonce: randomUUID()
            })
          }
        });
      }

      if (name === 'test_input_required_result_capabilities') {
        const clientCaps = meta[
          'io.modelcontextprotocol/clientCapabilities'
        ] as Record<string, unknown> | undefined;
        const inputRequests: Record<string, unknown> = {};

        if (clientCaps?.elicitation) {
          inputRequests['elicit_input'] = {
            method: 'elicitation/create',
            params: {
              message: 'Elicitation input',
              requestedSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value']
              }
            }
          };
        }
        if (clientCaps?.sampling) {
          inputRequests['sample_input'] = {
            method: 'sampling/createMessage',
            params: {
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Sample request' }
                }
              ],
              maxTokens: 50
            }
          };
        }

        if (inputResponses && Object.keys(inputResponses).length > 0) {
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `capabilities-ok: received ${Object.keys(inputResponses).join(',')}`
                }
              ]
            }
          });
        }
        if (Object.keys(inputRequests).length === 0) {
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'text', text: 'No supported capabilities declared' }
              ]
            }
          });
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'input_required',
            inputRequests,
            requestState: signMrtState({
              kind: 'capabilities-test',
              nonce: randomUUID()
            })
          }
        });
      }

      // Progressive IncompleteResult Stream Generator Handling
      if (name === 'test_streaming_elicitation') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        });

        res.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress', // Emits standard progress notice
            params: { progressToken: 'token-abc', total: 100, value: 50 }
          }) + '\n'
        );

        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'Streaming complete' }] }
          })
        );
      }

      // Contextual Logging Constraints Verification Handler
      if (name === 'test_logging_tool') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        });

        // RULE: No logs allowed if meta configuration lacks explicit log level bounds
        if (meta && meta['io.modelcontextprotocol/logLevel']) {
          res.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: {
                level: 'info',
                text: 'Diagnostic trace logging activated'
              }
            }) + '\n'
          );
        }

        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'Logging evaluated' }] }
          })
        );
      }

      // Helper mutation hooks used by dynamic tests to force stream activity
      // evaluation. The list change is fanned out to whichever
      // subscriptions/listen streams are currently open and asked for it.
      if (
        name === 'test_trigger_tool_change' ||
        name === 'test_trigger_prompt_change'
      ) {
        if (name === 'test_trigger_tool_change') {
          notifyListenStreams('tools', 'notifications/tools/list_changed');
        } else {
          notifyListenStreams('prompts', 'notifications/prompts/list_changed');
        }
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Mutation triggered' }] }
        });
      }
    }

    // Carry-forward methods that fell through the MRTR-specific handlers above
    // (tools/call for non-MRTR tools, resources/*, prompts/get for non-MRTR
    // prompts, completion/complete) are dispatched to the same McpServer the
    // stateful path uses, via an in-memory client. This avoids duplicating the
    // tool/resource/prompt registrations for the stateless path.
    //
    // tools/call is served as text/event-stream so progress and logging
    // notifications from the underlying tool reach the conformance client.
    if (method === 'tools/call') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      });
      const write = (msg: unknown) =>
        res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      const dispatch = await getStatelessDispatchClient();
      try {
        const result = await dispatch.client.request(
          { method, params },
          ResultSchema as any
        );
        for (const n of dispatch.drainNotifications()) write(n);
        write({ jsonrpc: '2.0', id, result });
      } catch (e: any) {
        for (const n of dispatch.drainNotifications()) write(n);
        write({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data: e.data }
        });
      } finally {
        await dispatch.close();
      }
      return res.end();
    }
    if (
      [
        'resources/list',
        'resources/read',
        'resources/templates/list',
        'prompts/get',
        'completion/complete'
      ].includes(method)
    ) {
      const dispatch = await getStatelessDispatchClient();
      try {
        const result = await dispatch.client.request(
          { method, params },
          ResultSchema as any
        );
        return res.json({ jsonrpc: '2.0', id, result });
      } catch (e: any) {
        // SEP-2164: unknown resources get -32602 with the requested uri in
        // data; the SDK's McpError does not populate data itself.
        const data =
          e.data ??
          (method === 'resources/read' ? { uri: params.uri } : undefined);
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: e.code ?? -32603, message: e.message, data }
        });
      } finally {
        await dispatch.close();
      }
    }

    // Removed Methods per SEP-2575 (Changed status from 200 to 400/404 per Transport Spec)
    if (
      [
        'initialize',
        'ping',
        'logging/setLevel',
        'resources/subscribe',
        'resources/unsubscribe'
      ].includes(method)
    ) {
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Method not found: removed stateful RPC'
        }
      });
    }

    // Generic Fallback Unknown Method Handling (HTTP 404, -32601)
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' }
    });
  }

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport for established sessions
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Create new transport for initialization requests
      const mcpServer = createMcpServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: createEventStore(),
        retryInterval: 5000, // 5 second retry interval for SEP-1699
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = mcpServer;
          console.log(`Session initialized with ID: ${newSessionId}`);
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            servers[sid].close();
            delete servers[sid];
          }
          console.log(`Session ${sid} closed`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid or missing session ID'
        },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

// Handle GET requests - SSE streams for sessions
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  const lastEventId = req.headers['last-event-id'] as string | undefined;
  if (lastEventId) {
    console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`Establishing SSE stream for session ${sessionId}`);
  }

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling SSE stream:', error);
    if (!res.headersSent) {
      res.status(500).send('Error establishing SSE stream');
    }
  }
});

// Handle DELETE requests - session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `MCP Conformance Test Server running on http://localhost:${PORT}`
  );
  console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
