import { ClientScenario, ConformanceCheck } from '../../types.js';
import { serverChecks } from '../../checks/index.js';

export class ServerInitializeClientScenario implements ClientScenario {
    name = 'server-initialize';
    description = 'Acts as MCP client to test external server initialization';

    async run(serverUrl: string): Promise<ConformanceCheck[]> {
        const checks: ConformanceCheck[] = [];

        try {
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        clientInfo: {
                            name: 'conformance-test-client',
                            version: '1.0.0'
                        }
                    }
                })
            });

            if (!response.ok) {
                const responseBody = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}. Response body: ${responseBody}`);
            }

            const responseText = await response.text();
            
            // Handle SSE format
            let result;
            if (responseText.startsWith('event:') || responseText.includes('\ndata:')) {
                // Parse SSE format - extract JSON from data: lines
                const lines = responseText.split('\n');
                const dataLines = lines.filter(line => line.startsWith('data: '));
                if (dataLines.length > 0) {
                    const jsonData = dataLines[0].substring(6); // Remove 'data: ' prefix
                    result = JSON.parse(jsonData);
                } else {
                    throw new Error(`SSE response without data line: ${responseText}`);
                }
            } else {
                // Regular JSON response
                result = JSON.parse(responseText);
            }
            
            const check = serverChecks.createServerInitializationCheck(result);
            checks.push(check);
        } catch (error) {
            checks.push({
                id: 'server-initialize-request',
                name: 'ServerInitializeRequest', 
                description: 'Tests server response to initialize request',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage: `Failed to send initialize request: ${error instanceof Error ? error.message : String(error)}`,
                details: {
                    error: error instanceof Error ? error.message : String(error),
                    serverUrl
                },
                specReferences: [
                    {
                        id: 'MCP-Initialize',
                        url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization'
                    }
                ]
            });
        }

        return checks;
    }
}