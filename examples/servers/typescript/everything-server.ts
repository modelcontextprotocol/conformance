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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ElicitResultSchema,
  McpError,
  ErrorCode
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

// Server state
const resourceSubscriptions = new Set<string>();
const watchedResourceContent = 'Watched resource content';

// Session management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

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
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' }
      }
    }
  },
  properties: {
    name: { type: 'string' },
    address: { $ref: '#/$defs/address' }
  },
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
              mode: 'form',
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
              mode: 'form',
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
              mode: 'form',
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

  // SEP-1036: URL mode elicitation
  mcpServer.registerTool(
    'test_elicitation_sep1036_url',
    {
      description: 'Tests URL mode elicitation per SEP-1036',
      inputSchema: {}
    },
    async () => {
      try {
        const elicitationId = `sep1036-test-${randomUUID()}`;
        const result = await mcpServer.server.elicitInput({
          mode: 'url',
          message: 'Please complete authorization to continue',
          url: 'https://mcp.example.com/authorize',
          elicitationId
        });

        return {
          content: [
            {
              type: 'text',
              text: `URL elicitation completed: action=${result.action}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `URL elicitation not supported or error: ${error.message}`
            }
          ]
        };
      }
    }
  );

  // SEP-1036: URL mode elicitation error flow
  mcpServer.registerTool(
    'test_elicitation_sep1036_error',
    {
      description:
        'Tests URLElicitationRequiredError flow per SEP-1036 (throws error)',
      inputSchema: {}
    },
    async () => {
      const elicitationId = `sep1036-error-${randomUUID()}`;
      throw new McpError(
        ErrorCode.UrlElicitationRequired,
        'Authorization required to access this resource',
        {
          elicitations: [
            {
              mode: 'url',
              message: 'Please authorize access to continue',
              url: 'https://mcp.example.com/authorize-error-test',
              elicitationId
            }
          ]
        }
      );
    }
  );

  // SEP-1036: URL mode elicitation with completion notification
  mcpServer.registerTool(
    'test_elicitation_sep1036_complete',
    {
      description:
        'Tests URL mode elicitation with completion notification per SEP-1036',
      inputSchema: {}
    },
    async () => {
      const elicitationId = `sep1036-complete-${randomUUID()}`;
      const result = await mcpServer.server.elicitInput({
        mode: 'url',
        message: 'Please complete the authorization flow',
        url: 'https://mcp.example.com/authorize-with-completion',
        elicitationId
      });

      // Send completion notification after client accepts
      if (result.action === 'accept') {
        // Create a notifier for this elicitationId and send the notification
        const notifier =
          mcpServer.server.createElicitationCompletionNotifier(elicitationId);
        await notifier();
      }
      return {
        content: [
          {
            type: 'text',
            text: `URL elicitation with completion: action=${result.action}, notification sent`
          }
        ]
      };
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

            // For other tools, convert Zod to JSON Schema
            // Handle different inputSchema formats:
            // - undefined/null: use empty object schema
            // - Zod schema (has _def): convert directly
            // - Raw shape (object with Zod values): wrap in z.object first
            let inputSchema: Tool['inputSchema'];
            if (!tool.inputSchema) {
              inputSchema = { type: 'object' as const, properties: {} };
            } else if ('_def' in tool.inputSchema) {
              // Already a Zod schema
              inputSchema = zodToJsonSchema(tool.inputSchema, {
                strictUnions: true
              }) as Tool['inputSchema'];
            } else if (
              typeof tool.inputSchema === 'object' &&
              Object.keys(tool.inputSchema).length > 0
            ) {
              // Raw shape with Zod values
              inputSchema = zodToJsonSchema(z.object(tool.inputSchema), {
                strictUnions: true
              }) as Tool['inputSchema'];
            } else {
              // Empty object or unknown format
              inputSchema = { type: 'object' as const, properties: {} };
            }

            return {
              name,
              title: tool.title,
              description: tool.description,
              inputSchema,
              annotations: tool.annotations,
              _meta: tool._meta
            };
          })
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

const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
  cors({
    origin: '*', // Allow all origins
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
  })
);

// Handle POST requests - stateful mode
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

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
