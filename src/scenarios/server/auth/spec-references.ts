import { SpecReference } from '../../../types';

export const SpecReferences: { [key: string]: SpecReference } = {
  MCP_AUTHORIZATION_SERVER_LOCATION: {
    id: 'MCP-Authorization-server-location',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-location'
  },
  MCP_PRM_DISCOVERY_REQUIREMENTS: {
    id: 'MCP-Protected-resource-metadata-discovery-requirements',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#protected-resource-metadata-discovery-requirements'
  },
  MCP_SCOPE_SELECTION_STRATEGY: {
    id: 'MCP-Scope-selection-strategy',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-selection-strategy'
  },
  MCP_AUTH_ERROR_HANDLING: {
    id: 'MCP-Auth-error-handling',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#error-handling'
  },
  RFC_9728_RESPONSE: {
    id: 'RFC-9728-protected-resource-metadata-response',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.2'
  },
  RFC_9728_VALIDATION: {
    id: 'RFC-9728-protected-resource-metadata-validation',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.3'
  },
  RFC_9728_WWW_AUTHENTICATE: {
    id: 'RFC-9728-www-authenticate',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1'
  }
};
