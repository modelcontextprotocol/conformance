import {
  ConformanceCheck,
  CheckStatus,
  LATEST_SPEC_VERSION,
  NEGOTIABLE_PROTOCOL_VERSIONS
} from '../types';

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
  expectedSpecVersion: string = LATEST_SPEC_VERSION
): ConformanceCheck {
  const protocolVersionSent = initializeRequest?.protocolVersion;

  // Accept known valid versions OR custom expected version (for backward compatibility)
  const validVersions = NEGOTIABLE_PROTOCOL_VERSIONS.includes(
    expectedSpecVersion
  )
    ? NEGOTIABLE_PROTOCOL_VERSIONS
    : [...NEGOTIABLE_PROTOCOL_VERSIONS, expectedSpecVersion];
  const versionMatch = validVersions.includes(protocolVersionSent);

  const errors: string[] = [];
  if (!protocolVersionSent) errors.push('Protocol version not provided');
  if (!versionMatch)
    errors.push(
      `Version mismatch: expected ${expectedSpecVersion}, got ${protocolVersionSent}`
    );
  // Presence and type, not truthiness. `Implementation` is
  // `"required": ["name", "version"]` with both a bare `{"type": "string"}`,
  // so a client sending `version: ''` has supplied the field; a falsy test
  // reports it as missing, and at FAILURE severity.
  const clientInfo = initializeRequest?.clientInfo;
  if (typeof clientInfo?.name !== 'string')
    errors.push("clientInfo needs a string 'name'");
  if (typeof clientInfo?.version !== 'string')
    errors.push("clientInfo needs a string 'version'");

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
