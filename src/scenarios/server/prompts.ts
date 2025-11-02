/**
 * Prompts test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';

export class PromptsListScenario implements ClientScenario {
    name = 'prompts-list';
    description = 'Test listing available prompts';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            const result = await connection.client.listPrompts();

            // Validate response structure
            const errors: string[] = [];
            if (!result.prompts) {
                errors.push('Missing prompts array');
            } else {
                if (!Array.isArray(result.prompts)) {
                    errors.push('prompts is not an array');
                }

                result.prompts.forEach((prompt, index) => {
                    if (!prompt.name) errors.push(`Prompt ${index}: missing name`);
                    if (!prompt.description) errors.push(`Prompt ${index}: missing description`);
                });
            }

            checks.push({
                id: 'prompts-list',
                name: 'PromptsList',
                description: 'Server lists available prompts with valid structure',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Prompts-List',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#listing-prompts'
                }],
                details: {
                    promptCount: result.prompts?.length || 0,
                    prompts: result.prompts?.map(p => p.name)
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'prompts-list',
                name: 'PromptsList',
                description: 'Server lists available prompts with valid structure',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Prompts-List',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#listing-prompts'
                }]
            });
        }

        return checks;
    }
}

export class PromptsGetSimpleScenario implements ClientScenario {
    name = 'prompts-get-simple';
    description = 'Test getting a simple prompt without arguments';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            const result = await connection.client.getPrompt({
                name: 'test_simple_prompt'
            });

            // Validate response
            const errors: string[] = [];
            if (!result.messages) errors.push('Missing messages array');
            if (!Array.isArray(result.messages)) errors.push('messages is not an array');
            if (result.messages.length === 0) errors.push('messages array is empty');

            result.messages.forEach((message: any, index: number) => {
                if (!message.role) errors.push(`Message ${index}: missing role`);
                if (!message.content) errors.push(`Message ${index}: missing content`);
            });

            checks.push({
                id: 'prompts-get-simple',
                name: 'PromptsGetSimple',
                description: 'Get simple prompt successfully',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Prompts-Get',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#getting-prompts'
                }],
                details: {
                    messageCount: result.messages?.length || 0
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'prompts-get-simple',
                name: 'PromptsGetSimple',
                description: 'Get simple prompt successfully',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Prompts-Get',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#getting-prompts'
                }]
            });
        }

        return checks;
    }
}

export class PromptsGetWithArgsScenario implements ClientScenario {
    name = 'prompts-get-with-args';
    description = 'Test parameterized prompt';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            const result = await connection.client.getPrompt({
                name: 'test_prompt_with_arguments',
                arguments: {
                    arg1: 'testValue1',
                    arg2: 'testValue2'
                }
            });

            // Validate response
            const errors: string[] = [];
            if (!result.messages) errors.push('Missing messages array');
            if (result.messages.length === 0) errors.push('messages array is empty');

            // Check if arguments were substituted
            const messageText = JSON.stringify(result.messages);
            if (!messageText.includes('testValue1')) {
                errors.push('arg1 not substituted in prompt');
            }
            if (!messageText.includes('testValue2')) {
                errors.push('arg2 not substituted in prompt');
            }

            checks.push({
                id: 'prompts-get-with-args',
                name: 'PromptsGetWithArgs',
                description: 'Get parameterized prompt with argument substitution',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Prompts-Get',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#getting-prompts'
                }],
                details: {
                    messageCount: result.messages?.length || 0,
                    messages: result.messages
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'prompts-get-with-args',
                name: 'PromptsGetWithArgs',
                description: 'Get parameterized prompt with argument substitution',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Prompts-Get',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#getting-prompts'
                }]
            });
        }

        return checks;
    }
}

export class PromptsGetEmbeddedResourceScenario implements ClientScenario {
    name = 'prompts-get-embedded-resource';
    description = 'Test prompt with embedded resource content';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            const result = await connection.client.getPrompt({
                name: 'test_prompt_with_embedded_resource',
                arguments: {
                    resourceUri: 'test://example-resource'
                }
            });

            // Validate response
            const errors: string[] = [];
            if (!result.messages) errors.push('Missing messages array');

            // Look for resource content
            const hasResourceContent = result.messages.some((msg: any) =>
                msg.content?.type === 'resource' ||
                (msg.content?.resource !== undefined)
            );

            if (!hasResourceContent) {
                errors.push('No embedded resource found in prompt');
            }

            checks.push({
                id: 'prompts-get-embedded-resource',
                name: 'PromptsGetEmbeddedResource',
                description: 'Get prompt with embedded resource',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Prompts-Embedded-Resources',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#embedded-resources'
                }],
                details: {
                    messageCount: result.messages?.length || 0,
                    messages: result.messages
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'prompts-get-embedded-resource',
                name: 'PromptsGetEmbeddedResource',
                description: 'Get prompt with embedded resource',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Prompts-Embedded-Resources',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#embedded-resources'
                }]
            });
        }

        return checks;
    }
}

export class PromptsGetWithImageScenario implements ClientScenario {
    name = 'prompts-get-with-image';
    description = 'Test prompt with image content';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            const result = await connection.client.getPrompt({
                name: 'test_prompt_with_image'
            });

            // Validate response
            const errors: string[] = [];
            if (!result.messages) errors.push('Missing messages array');

            // Look for image content
            const hasImageContent = result.messages.some((msg: any) =>
                msg.content?.type === 'image' &&
                msg.content?.data &&
                msg.content?.mimeType
            );

            if (!hasImageContent) {
                errors.push('No image content found in prompt');
            }

            checks.push({
                id: 'prompts-get-with-image',
                name: 'PromptsGetWithImage',
                description: 'Get prompt with image content',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Prompts-Image',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#image-content'
                }],
                details: {
                    messageCount: result.messages?.length || 0
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'prompts-get-with-image',
                name: 'PromptsGetWithImage',
                description: 'Get prompt with image content',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Prompts-Image',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#image-content'
                }]
            });
        }

        return checks;
    }
}
