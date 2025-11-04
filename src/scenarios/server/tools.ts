/**
 * Tools test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer, NotificationCollector } from './client-helper.js';
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  Progress
} from '@modelcontextprotocol/sdk/types.js';

export class ToolsListScenario implements ClientScenario {
  name = 'tools-list';
  description = 'Test listing available tools';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.listTools();

      // Validate response structure
      const errors: string[] = [];
      if (!result.tools) {
        errors.push('Missing tools array');
      } else {
        if (!Array.isArray(result.tools)) {
          errors.push('tools is not an array');
        }

        result.tools.forEach((tool, index) => {
          if (!tool.name) errors.push(`Tool ${index}: missing name`);
          if (!tool.description)
            errors.push(`Tool ${index}: missing description`);
          if (!tool.inputSchema)
            errors.push(`Tool ${index}: missing inputSchema`);
        });
      }

      checks.push({
        id: 'tools-list',
        name: 'ToolsList',
        description: 'Server lists available tools with valid structure',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-List',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#listing-tools'
          }
        ],
        details: {
          toolCount: result.tools?.length || 0,
          tools: result.tools?.map((t) => t.name)
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-list',
        name: 'ToolsList',
        description: 'Server lists available tools with valid structure',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-List',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#listing-tools'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallSimpleTextScenario implements ClientScenario {
  name = 'tools-call-simple-text';
  description = 'Test calling a tool that returns simple text';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.callTool({
        name: 'test_simple_text',
        arguments: {}
      });

      // Validate response
      const errors: string[] = [];
      const content = (result as any).content;
      if (!content) errors.push('Missing content array');
      if (!Array.isArray(content)) errors.push('content is not an array');
      if (content && content.length === 0)
        errors.push('content array is empty');

      const textContent =
        content && content.find((c: any) => c.type === 'text');
      if (!textContent) errors.push('No text content found');
      if (textContent && !textContent.text)
        errors.push('Text content missing text field');

      checks.push({
        id: 'tools-call-simple-text',
        name: 'ToolsCallSimpleText',
        description: 'Tool returns simple text content',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ],
        details: {
          result
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-simple-text',
        name: 'ToolsCallSimpleText',
        description: 'Tool returns simple text content',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallImageScenario implements ClientScenario {
  name = 'tools-call-image';
  description = 'Test calling a tool that returns image content';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.callTool({
        name: 'test_image_content',
        arguments: {}
      });

      // Validate response
      const errors: string[] = [];
      const content = (result as any).content;
      if (!content) errors.push('Missing content array');

      const imageContent =
        content && content.find((c: any) => c.type === 'image');
      if (!imageContent) errors.push('No image content found');
      if (imageContent && !imageContent.data)
        errors.push('Image content missing data field');
      if (imageContent && !imageContent.mimeType)
        errors.push('Image content missing mimeType');

      checks.push({
        id: 'tools-call-image',
        name: 'ToolsCallImage',
        description: 'Tool returns image content',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ],
        details: {
          mimeType: imageContent?.mimeType,
          hasData: !!imageContent?.data
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-image',
        name: 'ToolsCallImage',
        description: 'Tool returns image content',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallMultipleContentTypesScenario implements ClientScenario {
  name = 'tools-call-mixed-content';
  description = 'Test tool returning multiple content types';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.callTool({
        name: 'test_multiple_content_types',
        arguments: {}
      });

      // Validate response
      const errors: string[] = [];
      const content = (result as any).content;
      if (!content) errors.push('Missing content array');
      if (content && content.length < 2)
        errors.push('Expected multiple content items');

      const hasText = content && content.some((c: any) => c.type === 'text');
      const hasImage = content && content.some((c: any) => c.type === 'image');
      const hasResource =
        content && content.some((c: any) => c.type === 'resource');

      if (!hasText) errors.push('Missing text content');
      if (!hasImage) errors.push('Missing image content');
      if (!hasResource) errors.push('Missing resource content');

      checks.push({
        id: 'tools-call-mixed-content',
        name: 'ToolsCallMixedContent',
        description: 'Tool returns multiple content types',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ],
        details: {
          contentCount: content ? content.length : 0,
          contentTypes: content ? content.map((c: any) => c.type) : []
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-mixed-content',
        name: 'ToolsCallMixedContent',
        description: 'Tool returns multiple content types',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallWithLoggingScenario implements ClientScenario {
  name = 'tools-call-with-logging';
  description = 'Test tool that sends log messages during execution';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);
      const notifications = new NotificationCollector(connection.client);

      await connection.client.callTool({
        name: 'test_tool_with_logging',
        arguments: {}
      });

      // Wait a bit for notifications to arrive
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check for log notifications from the NotificationCollector
      const logNotifications = notifications.getNotifications();

      const errors: string[] = [];
      if (logNotifications.length === 0) {
        errors.push('No log notifications received');
      } else if (logNotifications.length < 3) {
        errors.push(
          `Expected at least 3 log messages, got ${logNotifications.length}`
        );
      }

      checks.push({
        id: 'tools-call-with-logging',
        name: 'ToolsCallWithLogging',
        description: 'Tool sends log messages during execution',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Logging',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging'
          }
        ],
        details: {
          logCount: logNotifications.length,
          logs: logNotifications.map((n: any) => n.params)
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-with-logging',
        name: 'ToolsCallWithLogging',
        description: 'Tool sends log messages during execution',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Logging',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallErrorScenario implements ClientScenario {
  name = 'tools-call-error';
  description = 'Test tool error reporting';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result: any = await connection.client.callTool({
        name: 'test_error_handling',
        arguments: {}
      });

      // Check if result has isError flag
      const hasIsError = result.isError === true;
      const hasContent = result.content && result.content.length > 0;
      const hasErrorMessage = hasContent && result.content[0].text;

      checks.push({
        id: 'tools-call-error',
        name: 'ToolsCallError',
        description: 'Tool returns error correctly',
        status: hasIsError && hasErrorMessage ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: !hasIsError
          ? 'Tool did not return isError: true'
          : !hasErrorMessage
            ? 'Error result missing error message'
            : undefined,
        specReferences: [
          {
            id: 'MCP-Error-Handling',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'
          }
        ],
        details: {
          result
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-error',
        name: 'ToolsCallError',
        description: 'Tool returns error correctly',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Error-Handling',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallWithProgressScenario implements ClientScenario {
  name = 'tools-call-with-progress';
  description = 'Test tool that reports progress notifications';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);
      const progressUpdates: Array<Progress> = [];
      // TODO: investigate why await connection.client.callTool didn't work for progress.
      const result = await connection.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'test_tool_with_progress',
            arguments: {},
            _meta: {
              progressToken: 'progress-test-1'
            }
          }
        },
        CallToolResultSchema,
        {
          onprogress: (progress) => {
            progressUpdates.push(progress);
          }
        }
      );

      const errors: string[] = [];
      if (progressUpdates.length === 0) {
        errors.push('No progress notifications received');
      } else if (progressUpdates.length < 3) {
        errors.push(
          `Expected at least 3 progress notifications, got ${progressUpdates.length}`
        );
      }

      if (progressUpdates.length >= 3) {
        const progress0 = progressUpdates[0].progress;
        const progress1 = progressUpdates[1].progress;
        const progress2 = progressUpdates[2].progress;

        if (!(progress0 <= progress1 && progress1 <= progress2)) {
          errors.push('Progress values should be increasing');
        }
      }

      checks.push({
        id: 'tools-call-with-progress',
        name: 'ToolsCallWithProgress',
        description: 'Tool reports progress notifications',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Progress',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/progress'
          }
        ],
        details: {
          progressCount: progressUpdates.length,
          progressNotifications: progressUpdates.map((n: Progress) => n),
          result
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-with-progress',
        name: 'ToolsCallWithProgress',
        description: 'Tool reports progress notifications',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Progress',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/progress'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallSamplingScenario implements ClientScenario {
  name = 'tools-call-sampling';
  description = 'Test tool that requests LLM sampling from client';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      let samplingRequested = false;
      connection.client.setRequestHandler(
        CreateMessageRequestSchema,
        async (_request) => {
          samplingRequested = true;
          return {
            role: 'assistant',
            content: {
              type: 'text',
              text: 'This is a test response from the client'
            },
            model: 'test-model',
            stopReason: 'endTurn'
          };
        }
      );

      const result = await connection.client.callTool({
        name: 'test_sampling',
        arguments: {
          prompt: 'Test prompt for sampling'
        }
      });

      const errors: string[] = [];
      if (!samplingRequested) {
        errors.push('Server did not request sampling from client');
      }

      const content = (result as any).content;
      if (!content || content.length === 0) {
        errors.push('Tool did not return content');
      }

      checks.push({
        id: 'tools-call-sampling',
        name: 'ToolsCallSampling',
        description: 'Tool requests LLM sampling from client',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Sampling',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/sampling'
          }
        ],
        details: {
          samplingRequested,
          result
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-sampling',
        name: 'ToolsCallSampling',
        description: 'Tool requests LLM sampling from client',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Sampling',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/sampling'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallElicitationScenario implements ClientScenario {
  name = 'tools-call-elicitation';
  description = 'Test tool that requests user input (elicitation) from client';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      let elicitationRequested = false;
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (_request) => {
          elicitationRequested = true;
          return {
            action: 'accept',
            content: {
              username: 'testuser',
              email: 'test@example.com'
            }
          };
        }
      );

      const result = await connection.client.callTool({
        name: 'test_elicitation',
        arguments: {
          message: 'Please provide your information'
        }
      });

      const errors: string[] = [];
      if (!elicitationRequested) {
        errors.push('Server did not request elicitation from client');
      }

      const content = (result as any).content;
      if (!content || content.length === 0) {
        errors.push('Tool did not return content');
      }

      checks.push({
        id: 'tools-call-elicitation',
        name: 'ToolsCallElicitation',
        description: 'Tool requests user input from client',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Elicitation',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/elicitation'
          }
        ],
        details: {
          elicitationRequested,
          result
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-elicitation',
        name: 'ToolsCallElicitation',
        description: 'Tool requests user input from client',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Elicitation',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/elicitation'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallAudioScenario implements ClientScenario {
  name = 'tools-call-audio';
  description = 'Test calling a tool that returns audio content';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.callTool({
        name: 'test_audio_content',
        arguments: {}
      });

      // Validate response
      const errors: string[] = [];
      const content = (result as any).content;
      if (!content) errors.push('Missing content array');
      if (!Array.isArray(content)) errors.push('content is not an array');
      if (content && content.length === 0)
        errors.push('content array is empty');

      const audioContent =
        content && content.find((c: any) => c.type === 'audio');
      if (!audioContent) errors.push('No audio content found');
      if (audioContent && !audioContent.data)
        errors.push('Audio content missing data field');
      if (audioContent && !audioContent.mimeType)
        errors.push('Audio content missing mimeType field');
      if (audioContent && audioContent.mimeType !== 'audio/wav')
        errors.push(
          `Expected mimeType 'audio/wav', got '${audioContent.mimeType}'`
        );

      checks.push({
        id: 'tools-call-audio',
        name: 'ToolsCallAudio',
        description: 'Tool returns audio content',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ],
        details: {
          hasAudioContent: !!audioContent,
          audioDataLength: audioContent?.data?.length || 0
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-audio',
        name: 'ToolsCallAudio',
        description: 'Tool returns audio content',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}

export class ToolsCallEmbeddedResourceScenario implements ClientScenario {
  name = 'tools-call-embedded-resource';
  description = 'Test calling a tool that returns embedded resource content';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.callTool({
        name: 'test_embedded_resource',
        arguments: {}
      });

      // Validate response
      const errors: string[] = [];
      const content = (result as any).content;
      if (!content) errors.push('Missing content array');
      if (!Array.isArray(content)) errors.push('content is not an array');
      if (content && content.length === 0)
        errors.push('content array is empty');

      const resourceContent =
        content && content.find((c: any) => c.type === 'resource');
      if (!resourceContent) errors.push('No resource content found');
      if (resourceContent && !resourceContent.resource)
        errors.push('Resource content missing resource field');
      if (resourceContent?.resource) {
        if (!resourceContent.resource.uri)
          errors.push('Resource missing uri field');
        if (!resourceContent.resource.mimeType)
          errors.push('Resource missing mimeType field');
        if (!resourceContent.resource.text && !resourceContent.resource.blob) {
          errors.push('Resource missing both text and blob fields');
        }
      }

      checks.push({
        id: 'tools-call-embedded-resource',
        name: 'ToolsCallEmbeddedResource',
        description: 'Tool returns embedded resource content',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ],
        details: {
          hasResourceContent: !!resourceContent,
          resourceUri: resourceContent?.resource?.uri
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'tools-call-embedded-resource',
        name: 'ToolsCallEmbeddedResource',
        description: 'Tool returns embedded resource content',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Tools-Call',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
          }
        ]
      });
    }

    return checks;
  }
}
