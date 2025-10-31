import { ConformanceCheck, CheckStatus } from './types.js';

export function createClientInitializationCheck(initializeRequest: any, expectedSpecVersion: string = '2025-06-18'): ConformanceCheck {
    const protocolVersionSent = initializeRequest?.protocolVersion;
    const versionMatch = protocolVersionSent === expectedSpecVersion;

    const errors: string[] = [];
    if (!protocolVersionSent) errors.push('Protocol version not provided');
    if (!versionMatch) errors.push(`Version mismatch: expected ${expectedSpecVersion}, got ${protocolVersionSent}`);
    if (!initializeRequest?.clientInfo?.name) errors.push('Client name missing');
    if (!initializeRequest?.clientInfo?.version) errors.push('Client version missing');

    const status: CheckStatus = errors.length === 0 ? 'SUCCESS' : 'FAILURE';

    return {
        id: 'mcp-client-initialization',
        name: 'MCPClientInitialization',
        description: 'Validates that MCP client properly initializes with server',
        status,
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'MCP-Lifecycle', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle' }],
        details: {
            protocolVersionSent,
            expectedSpecVersion,
            versionMatch,
            clientName: initializeRequest?.clientInfo?.name,
            clientVersion: initializeRequest?.clientInfo?.version
        },
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        logs: errors.length > 0 ? errors : undefined
    };
}

export function createServerInfoCheck(serverInfo: { name: string; version: string }): ConformanceCheck {
    return {
        id: 'server-info',
        name: 'ServerInfo',
        description: 'Test server info returned to client',
        status: 'INFO',
        timestamp: new Date().toISOString(),
        specReferences: [{ id: 'MCP-Lifecycle', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle' }],
        details: {
            serverName: serverInfo.name,
            serverVersion: serverInfo.version
        }
    };
}

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
