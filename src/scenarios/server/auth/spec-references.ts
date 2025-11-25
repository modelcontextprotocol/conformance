/**
 * Specification references for server OAuth conformance tests.
 *
 * These references link test checks to the relevant sections of:
 * - RFC 9728 (OAuth Protected Resource Metadata)
 * - RFC 6750 (Bearer Token Usage)
 * - RFC 7235 (HTTP Authentication)
 * - MCP Authorization Specification
 */

import { SpecReference } from '../../../types';

export const ServerAuthSpecReferences: Record<string, SpecReference> = {
  /**
   * RFC 9728: OAuth 2.0 Protected Resource Metadata
   */
  RFC_9728_PRM_DISCOVERY: {
    id: 'RFC-9728-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.1'
  },

  RFC_9728_PRM_RESPONSE: {
    id: 'RFC-9728-3.2',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.2'
  },

  /**
   * RFC 6750: Bearer Token Usage
   */
  RFC_6750_BEARER_TOKEN: {
    id: 'RFC-6750-2.1',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1'
  },

  RFC_6750_ERROR_CODES: {
    id: 'RFC-6750-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1'
  },

  RFC_6750_WWW_AUTHENTICATE: {
    id: 'RFC-6750-3',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3'
  },

  /**
   * RFC 7235: HTTP Authentication
   */
  RFC_7235_WWW_AUTHENTICATE: {
    id: 'RFC-7235-4.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-4.1'
  },

  RFC_7235_401_RESPONSE: {
    id: 'RFC-7235-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-3.1'
  },

  /**
   * MCP Authorization Specification
   */
  MCP_AUTH_PRM_DISCOVERY: {
    id: 'MCP-Authorization-PRM',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#protected-resource-metadata-discovery-requirements'
  },

  MCP_AUTH_ACCESS_TOKEN: {
    id: 'MCP-Authorization-Token',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#access-token-usage'
  },

  MCP_AUTH_SCOPE_SELECTION: {
    id: 'MCP-Authorization-Scope',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-selection-strategy'
  },

  MCP_AUTH_ERROR_HANDLING: {
    id: 'MCP-Authorization-Errors',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#error-handling'
  }
};
