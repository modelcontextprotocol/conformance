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
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
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