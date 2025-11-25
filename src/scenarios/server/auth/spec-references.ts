/**
 * Specification references for server OAuth conformance tests.
 *
 * These references link test checks to the relevant sections of:
 * - RFC 9728 (OAuth 2.0 Protected Resource Metadata)
 * - RFC 8414 (OAuth 2.0 Authorization Server Metadata)
 * - RFC 7591 (OAuth 2.0 Dynamic Client Registration)
 * - RFC 8707 (Resource Indicators for OAuth 2.0)
 * - RFC 6750 (Bearer Token Usage)
 * - RFC 7235 (HTTP Authentication)
 * - OAuth 2.1 Draft
 * - MCP Authorization Specification (2025-06-18)
 */

import { SpecReference } from '../../../types';

export const ServerAuthSpecReferences: Record<string, SpecReference> = {
  // ============================================================
  // RFC 9728: OAuth 2.0 Protected Resource Metadata
  // https://datatracker.ietf.org/doc/html/rfc9728
  // ============================================================

  /** Section 3: Obtaining Protected Resource Metadata */
  RFC_9728_PRM_DISCOVERY: {
    id: 'RFC-9728-3',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3'
  },

  /** Section 3.2: Protected Resource Metadata Response */
  RFC_9728_PRM_RESPONSE: {
    id: 'RFC-9728-3.2',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.2'
  },

  /** Section 2: Protected Resource Metadata (required fields) */
  RFC_9728_PRM_FIELDS: {
    id: 'RFC-9728-2',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-2'
  },

  /** Section 5: Use of WWW-Authenticate for Protected Resource Metadata */
  RFC_9728_WWW_AUTHENTICATE: {
    id: 'RFC-9728-5',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-5'
  },

  /** Section 5.1: WWW-Authenticate Response (resource_metadata parameter) */
  RFC_9728_WWW_AUTHENTICATE_RESPONSE: {
    id: 'RFC-9728-5.1',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1'
  },

  // ============================================================
  // RFC 8414: OAuth 2.0 Authorization Server Metadata
  // https://datatracker.ietf.org/doc/html/rfc8414
  // ============================================================

  /** Section 3: Obtaining Authorization Server Metadata */
  RFC_8414_AS_DISCOVERY: {
    id: 'RFC-8414-3',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-3'
  },

  /** Section 3.2: Authorization Server Metadata Response */
  RFC_8414_AS_RESPONSE: {
    id: 'RFC-8414-3.2',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-3.2'
  },

  /** Section 2: Authorization Server Metadata (required fields) */
  RFC_8414_AS_FIELDS: {
    id: 'RFC-8414-2',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-2'
  },

  // ============================================================
  // RFC 7591: OAuth 2.0 Dynamic Client Registration
  // https://datatracker.ietf.org/doc/html/rfc7591
  // ============================================================

  /** Section 3: Client Registration Endpoint */
  RFC_7591_REGISTRATION_ENDPOINT: {
    id: 'RFC-7591-3',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3'
  },

  /** Section 3.1: Client Registration Request */
  RFC_7591_REGISTRATION_REQUEST: {
    id: 'RFC-7591-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3.1'
  },

  /** Section 3.2: Client Registration Response */
  RFC_7591_REGISTRATION_RESPONSE: {
    id: 'RFC-7591-3.2',
    url: 'https://www.rfc-editor.org/rfc/rfc7591.html#section-3.2'
  },

  // ============================================================
  // RFC 8707: Resource Indicators for OAuth 2.0
  // https://www.rfc-editor.org/rfc/rfc8707.html
  // ============================================================

  /** Section 2: Resource Parameter */
  RFC_8707_RESOURCE_PARAMETER: {
    id: 'RFC-8707-2',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2'
  },

  /** Section 2.1: Authorization Request (resource in authz request) */
  RFC_8707_AUTHORIZATION_REQUEST: {
    id: 'RFC-8707-2.1',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2.1'
  },

  /** Section 2.2: Access Token Request (resource in token request) */
  RFC_8707_TOKEN_REQUEST: {
    id: 'RFC-8707-2.2',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2.2'
  },

  /** Section 3: Security Considerations (audience validation) */
  RFC_8707_SECURITY: {
    id: 'RFC-8707-3',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-3'
  },

  // ============================================================
  // RFC 6750: Bearer Token Usage
  // https://datatracker.ietf.org/doc/html/rfc6750
  // ============================================================

  /** Section 2.1: Authorization Request Header Field */
  RFC_6750_BEARER_TOKEN: {
    id: 'RFC-6750-2.1',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1'
  },

  /** Section 3: WWW-Authenticate Response Header Field */
  RFC_6750_WWW_AUTHENTICATE: {
    id: 'RFC-6750-3',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3'
  },

  /** Section 3.1: Error Codes (invalid_request, invalid_token, insufficient_scope) */
  RFC_6750_ERROR_CODES: {
    id: 'RFC-6750-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1'
  },

  // ============================================================
  // RFC 7235: HTTP Authentication
  // https://datatracker.ietf.org/doc/html/rfc7235
  // ============================================================

  /** Section 3.1: 401 Unauthorized */
  RFC_7235_401_RESPONSE: {
    id: 'RFC-7235-3.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-3.1'
  },

  /** Section 4.1: WWW-Authenticate */
  RFC_7235_WWW_AUTHENTICATE: {
    id: 'RFC-7235-4.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7235.html#section-4.1'
  },

  // ============================================================
  // OAuth 2.1 Draft
  // https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13
  // ============================================================

  /** Section 5: Resource Requests */
  OAUTH_2_1_RESOURCE_REQUESTS: {
    id: 'OAuth-2.1-5',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5'
  },

  /** Section 5.2: Token Validation */
  OAUTH_2_1_TOKEN_VALIDATION: {
    id: 'OAuth-2.1-5.2',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2'
  },

  /** Section 5.3: Error Response */
  OAUTH_2_1_ERROR_RESPONSE: {
    id: 'OAuth-2.1-5.3',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.3'
  },

  /** Section 7.5.2: PKCE */
  OAUTH_2_1_PKCE: {
    id: 'OAuth-2.1-7.5.2',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-7.5.2'
  },

  // ============================================================
  // MCP Authorization Specification (2025-06-18)
  // https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
  // ============================================================

  /** Authorization Server Location (PRM, WWW-Authenticate) */
  MCP_AUTH_SERVER_LOCATION: {
    id: 'MCP-2025-06-18-Authorization-Server-Location',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-location'
  },

  /** PRM Discovery (alias for Authorization Server Location) */
  MCP_AUTH_PRM_DISCOVERY: {
    id: 'MCP-2025-06-18-PRM-Discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-location'
  },

  /** Server Metadata Discovery (RFC 8414) */
  MCP_AUTH_SERVER_METADATA_DISCOVERY: {
    id: 'MCP-2025-06-18-Server-Metadata-Discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#server-metadata-discovery'
  },

  /** Dynamic Client Registration */
  MCP_AUTH_DCR: {
    id: 'MCP-2025-06-18-DCR',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#dynamic-client-registration'
  },

  /** Resource Parameter Implementation */
  MCP_AUTH_RESOURCE_PARAMETER: {
    id: 'MCP-2025-06-18-Resource-Parameter',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation'
  },

  /** Canonical Server URI */
  MCP_AUTH_CANONICAL_URI: {
    id: 'MCP-2025-06-18-Canonical-URI',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#canonical-server-uri'
  },

  /** Access Token Usage */
  MCP_AUTH_ACCESS_TOKEN: {
    id: 'MCP-2025-06-18-Access-Token',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#access-token-usage'
  },

  /** Token Requirements */
  MCP_AUTH_TOKEN_REQUIREMENTS: {
    id: 'MCP-2025-06-18-Token-Requirements',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-requirements'
  },

  /** Token Handling */
  MCP_AUTH_TOKEN_HANDLING: {
    id: 'MCP-2025-06-18-Token-Handling',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling'
  },

  /** Error Handling */
  MCP_AUTH_ERROR_HANDLING: {
    id: 'MCP-2025-06-18-Error-Handling',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#error-handling'
  },

  /** Token Audience Binding and Validation */
  MCP_AUTH_AUDIENCE_VALIDATION: {
    id: 'MCP-2025-06-18-Audience-Validation',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-audience-binding-and-validation'
  },

  /** Security Considerations */
  MCP_AUTH_SECURITY: {
    id: 'MCP-2025-06-18-Security',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#security-considerations'
  },

  /** Confused Deputy Problem */
  MCP_AUTH_CONFUSED_DEPUTY: {
    id: 'MCP-2025-06-18-Confused-Deputy',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#confused-deputy-problem'
  },

  /** Access Token Privilege Restriction */
  MCP_AUTH_TOKEN_RESTRICTION: {
    id: 'MCP-2025-06-18-Token-Restriction',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#access-token-privilege-restriction'
  },

  /** Scope Selection Strategy (resource_metadata in WWW-Authenticate) */
  MCP_AUTH_SCOPE_SELECTION: {
    id: 'RFC-9728-5.1',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1'
  }
};
