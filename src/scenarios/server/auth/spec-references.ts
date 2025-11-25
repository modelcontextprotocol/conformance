/**
 * Specification references for server OAuth conformance tests.
 *
 * Links test checks to relevant specifications:
 * - RFC 9728 (Protected Resource Metadata)
 * - RFC 8414 (Authorization Server Metadata)
 * - RFC 7591 (Dynamic Client Registration)
 * - RFC 7636 (PKCE)
 * - RFC 6750 (Bearer Token Usage)
 * - RFC 7235 (HTTP Authentication)
 * - RFC 8707 (Resource Indicators)
 * - MCP Authorization Specification (2025-06-18)
 * - IETF CIMD Draft (Client ID Metadata Documents)
 */

import { SpecReference } from '../../../types';

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
  RFC_9728_PRM_FIELDS: {
    id: 'RFC-9728-fields',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-2'
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
  RFC_8414_AS_RESPONSE: {
    id: 'RFC-8414-response',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-3.2'
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
  // RFC 7636: PKCE (Proof Key for Code Exchange)
  // ─────────────────────────────────────────────────────────────────────────
  RFC_7636_CODE_CHALLENGE: {
    id: 'RFC-7636-code-challenge',
    url: 'https://www.rfc-editor.org/rfc/rfc7636.html#section-4.2'
  },
  RFC_7636_CODE_CHALLENGE_METHODS: {
    id: 'RFC-7636-methods',
    url: 'https://www.rfc-editor.org/rfc/rfc7636.html#section-4.2'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RFC 8707: Resource Indicators
  // ─────────────────────────────────────────────────────────────────────────
  RFC_8707_RESOURCE_PARAMETER: {
    id: 'RFC-8707-resource',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2'
  },
  RFC_8707_SECURITY: {
    id: 'RFC-8707-security',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-3'
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
  RFC_6750_ERROR_CODES: {
    id: 'RFC-6750-errors',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1'
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
  OAUTH_2_1_TOKEN_VALIDATION: {
    id: 'OAuth-2.1-token-validation',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2'
  },
  OAUTH_2_1_ERROR_RESPONSE: {
    id: 'OAuth-2.1-error-response',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.3'
  },
  OAUTH_2_1_PKCE: {
    id: 'OAuth-2.1-pkce',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-7.5.2'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // MCP Authorization Specification (2025-06-18)
  // https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
  // ─────────────────────────────────────────────────────────────────────────
  MCP_AUTH_SERVER_LOCATION: {
    id: 'MCP-2025-06-18-server-location',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-location'
  },
  MCP_AUTH_PRM_DISCOVERY: {
    id: 'MCP-2025-06-18-prm-discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-location'
  },
  MCP_AUTH_SERVER_METADATA: {
    id: 'MCP-2025-06-18-server-metadata',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#server-metadata-discovery'
  },
  MCP_AUTH_DCR: {
    id: 'MCP-2025-06-18-dcr',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#dynamic-client-registration'
  },
  MCP_AUTH_ACCESS_TOKEN: {
    id: 'MCP-2025-06-18-access-token',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#access-token-usage'
  },
  MCP_AUTH_ERROR_HANDLING: {
    id: 'MCP-2025-06-18-error-handling',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#error-handling'
  },
  MCP_AUTH_AUDIENCE_VALIDATION: {
    id: 'MCP-2025-06-18-audience-validation',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-audience-binding-and-validation'
  },
  MCP_AUTH_CANONICAL_URI: {
    id: 'MCP-2025-06-18-canonical-uri',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#canonical-server-uri'
  },
  MCP_AUTH_SCOPE_SELECTION: {
    id: 'MCP-scope-selection',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#scope-selection-strategy'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // IETF CIMD: Client ID Metadata Documents
  // https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
  // Note: CIMD is defined in the IETF draft, not in MCP spec directly.
  //       It provides an alternative to DCR for client registration.
  // ─────────────────────────────────────────────────────────────────────────
  IETF_CIMD: {
    id: 'IETF-CIMD',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00'
  },
  IETF_CIMD_CLIENT_ID_SYNTAX: {
    id: 'IETF-CIMD-client-id-syntax',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#section-3.1'
  },
  IETF_CIMD_CLIENT_METADATA: {
    id: 'IETF-CIMD-client-metadata',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#section-3.2'
  },
  IETF_CIMD_AS_METADATA: {
    id: 'IETF-CIMD-as-metadata',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#section-4'
  },
  IETF_CIMD_SECURITY: {
    id: 'IETF-CIMD-security',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#section-6'
  },

  // ─────────────────────────────────────────────────────────────────────────
  // OpenID Connect Discovery 1.0
  // ─────────────────────────────────────────────────────────────────────────
  OIDC_DISCOVERY: {
    id: 'OIDC-discovery',
    url: 'https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig'
  }
};
