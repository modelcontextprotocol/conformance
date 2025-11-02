/**
 * Utilities test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';

export class LoggingSetLevelScenario implements ClientScenario {
    name = 'logging-set-level';
    description = 'Test setting logging level';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            // Send logging/setLevel request
            const result = await connection.client.setLoggingLevel('info');

            // Validate response (should return empty object {})
            const errors: string[] = [];
            if (result && Object.keys(result).length > 0) {
                errors.push('Expected empty object {} response');
            }

            checks.push({
                id: 'logging-set-level',
                name: 'LoggingSetLevel',
                description: 'Server accepts logging level setting',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Logging',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging'
                }],
                details: {
                    result
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'logging-set-level',
                name: 'LoggingSetLevel',
                description: 'Server accepts logging level setting',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Logging',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging'
                }]
            });
        }

        return checks;
    }
}

export class CompletionCompleteScenario implements ClientScenario {
    name = 'completion-complete';
    description = 'Test completion endpoint';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const connection = await connectToServer(serverUrl);

            // Send completion/complete request
            const result = await connection.client.complete(
                {
                    ref: {
                        type: 'ref/prompt',
                        name: 'test_prompt_with_arguments'
                    },
                    argument: {
                        name: 'arg1',
                        value: 'test'
                    }
                }
            );

            // Validate response structure
            const errors: string[] = [];
            if (!result.completion) {
                errors.push('Missing completion field');
            } else {
                if (!result.completion.values) errors.push('Missing values array in completion');
                if (!Array.isArray(result.completion.values)) errors.push('completion.values is not an array');
            }

            checks.push({
                id: 'completion-complete',
                name: 'CompletionComplete',
                description: 'Server responds to completion requests',
                status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
                specReferences: [{
                    id: 'MCP-Completion',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion'
                }],
                details: {
                    result
                }
            });

            await connection.close();
        } catch (error) {
            checks.push({
                id: 'completion-complete',
                name: 'CompletionComplete',
                description: 'Server responds to completion requests',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
                specReferences: [{
                    id: 'MCP-Completion',
                    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion'
                }]
            });
        }

        return checks;
    }
}
