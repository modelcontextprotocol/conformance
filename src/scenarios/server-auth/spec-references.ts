/**
 * Specification references for server OAuth conformance tests.
 *
 * Links test checks to relevant specifications:
 * - RFC 9728 (Protected Resource Metadata)
 * - RFC 8414 (Authorization Server Metadata)
 * - RFC 7591 (Dynamic Client Registration)
 * - RFC 6750 (Bearer Token Usage)
 * - OAuth 2.1 Draft (Client Credentials, Token Endpoint Auth)
 * - MCP Authorization Specification (2025-11-25)
 */

import { SpecReference } from '../../types';

export const ServerAuthSpecReferences: { [key: string]: SpecReference } = {
  // ─────────────────────────────────────────────────────────────────────────
  // RFC 9728: Protected Resource Metadata
  // ─────────────────────────────────────────────────────────────────────────
  RFC_9728_PRM_DISCOVERY: {
    id: 'RFC-9728-discovery',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3'
  },
  RFC_9728_PRM_RESPONSE: {
    id: 'RFC-9728-response',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.2'
  },
  RFC_9728_WWW_AUTHENTICATE: {
    id: 'RFC-9728-www-authenticate',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-5'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RFC 8414: Authorization Server Metadata
  // ─────────────────────────────────────────────────────────────────────────
  RFC_8414_AS_DISCOVERY: {
    id: 'RFC-8414-discovery',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-3'
  },
  RFC_8414_AS_FIELDS: {
    id: 'RFC-8414-fields',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-2'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RFC 7591: Dynamic Client Registration (DCR)
  // ─────────────────────────────────────────────────────────────────────────
  RFC_7591_DCR_ENDPOINT: {
    id: 'RFC-7591-endpoint',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3'
  },
  RFC_7591_DCR_REQUEST: {
    id: 'RFC-7591-request',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3.1'
  },
  RFC_7591_DCR_RESPONSE: {
    id: 'RFC-7591-response',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3.2'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RFC 6750: Bearer Token Usage
  // ─────────────────────────────────────────────────────────────────────────
  RFC_6750_BEARER_TOKEN: {
    id: 'RFC-6750-bearer',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1'
  },
  RFC_6750_WWW_AUTHENTICATE: {
    id: 'RFC-6750-www-authenticate',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RFC 7235: HTTP Authentication
  // ─────────────────────────────────────────────────────────────────────────
  RFC_7235_401_RESPONSE: {
    id: 'RFC-7235-401',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-3.1'
  },
  RFC_7235_WWW_AUTHENTICATE: {
    id: 'RFC-7235-www-authenticate',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-4.1'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // OAuth 2.1 Draft
  // ─────────────────────────────────────────────────────────────────────────
  OAUTH_2_1_CLIENT_CREDENTIALS: {
    id: 'OAuth-2.1-client-credentials',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#section-4.2'
  },
  OAUTH_2_1_TOKEN_REQUEST: {
    id: 'OAuth-2.1-token-request',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#name-token-request'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // MCP Authorization Specification (2025-11-25)
  // ─────────────────────────────────────────────────────────────────────────
  MCP_AUTH_SERVER_LOCATION: {
    id: 'MCP-2025-11-25-server-location',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-location'
  },
  MCP_AUTH_PRM_DISCOVERY: {
    id: 'MCP-2025-11-25-prm-discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#protected-resource-metadata-discovery-requirements'
  },
  MCP_AUTH_SERVER_METADATA: {
    id: 'MCP-2025-11-25-server-metadata',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-metadata-discovery'
  },
  MCP_AUTH_DCR: {
    id: 'MCP-2025-11-25-dcr',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#dynamic-client-registration'
  },
  MCP_AUTH_ACCESS_TOKEN: {
    id: 'MCP-2025-11-25-access-token',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-usage'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // MCP Extension: Client Credentials (SEP-1046)
  // ─────────────────────────────────────────────────────────────────────────
  SEP_1046_CLIENT_CREDENTIALS: {
    id: 'SEP-1046-client-credentials',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/oauth-client-credentials.mdx'
  }
};
