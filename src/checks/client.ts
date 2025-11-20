import { ConformanceCheck, CheckStatus } from '../types';

export function createServerInfoCheck(serverInfo: {
  name: string;
  version: string;
}): ConformanceCheck {
  return {
    id: 'server-info',
    name: 'ServerInfo',
    description: 'Test server info returned to client',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    specReferences: [
      {
        id: 'MCP-Lifecycle',
        url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'
      }
    ],
    details: {
      serverName: serverInfo.name,
      serverVersion: serverInfo.version
    }
  };
}

export function createClientInitializationCheck(
  initializeRequest: any,
  expectedSpecVersion: string = '2025-06-18'
): ConformanceCheck {
  const protocolVersionSent = initializeRequest?.protocolVersion;
  const versionMatch = protocolVersionSent === expectedSpecVersion;

  const errors: string[] = [];
  if (!protocolVersionSent) errors.push('Protocol version not provided');
  if (!versionMatch)
    errors.push(
      `Version mismatch: expected ${expectedSpecVersion}, got ${protocolVersionSent}`
    );
  if (!initializeRequest?.clientInfo?.name) errors.push('Client name missing');
  if (!initializeRequest?.clientInfo?.version)
    errors.push('Client version missing');

  const status: CheckStatus = errors.length === 0 ? 'SUCCESS' : 'FAILURE';

  return {
    id: 'mcp-client-initialization',
    name: 'MCPClientInitialization',
    description: 'Validates that MCP client properly initializes with server',
    status,
    timestamp: new Date().toISOString(),
    specReferences: [
      {
        id: 'MCP-Lifecycle',
        url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'
      }
    ],
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
