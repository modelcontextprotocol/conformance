import { ConformanceCheck, CheckStatus } from '../types.js';

export function createServerInitializationCheck(initializeResponse: any, expectedSpecVersion: string = '2025-06-18'): ConformanceCheck {
    const result = initializeResponse?.result;
    const protocolVersion = result?.protocolVersion;
    const serverInfo = result?.serverInfo;
    const capabilities = result?.capabilities;
    
    const errors: string[] = [];
    if (!initializeResponse?.jsonrpc) errors.push('Missing jsonrpc field');
    if (!initializeResponse?.id) errors.push('Missing id field');
    if (!result) errors.push('Missing result field');
    if (!protocolVersion) errors.push('Missing protocolVersion in result');
    if (protocolVersion !== expectedSpecVersion) errors.push(`Protocol version mismatch: expected ${expectedSpecVersion}, got ${protocolVersion}`);
    if (!serverInfo) errors.push('Missing serverInfo in result');
    if (!serverInfo?.name) errors.push('Missing server name in serverInfo');
    if (!serverInfo?.version) errors.push('Missing server version in serverInfo');
    if (capabilities === undefined) errors.push('Missing capabilities in result');

    const status: CheckStatus = errors.length === 0 ? 'SUCCESS' : 'FAILURE';

    return {
        id: 'mcp-server-initialization',
        name: 'MCPServerInitialization',
        description: 'Validates that MCP server properly responds to initialize request',
        status,
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'MCP-Lifecycle', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle' }],
        details: {
            expectedSpecVersion,
            ...initializeResponse
        },
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        logs: errors.length > 0 ? errors : undefined
    };
}