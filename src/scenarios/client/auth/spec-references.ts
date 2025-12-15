import { SpecReference } from '../../../types';

export const SpecReferences: { [key: string]: SpecReference } = {
  RFC_PRM_DISCOVERY: {
    id: 'RFC-9728',
    url: 'https://www.rfc-editor.org/rfc/rfc9728.html#section-3.1'
  },
  RFC_AUTH_SERVER_METADATA_REQUEST: {
    id: 'RFC-8414-metadata-request',
    url: 'https://www.rfc-editor.org/rfc/rfc8414.html#section-3.1'
  },
  LEGACY_2025_03_26_AUTH_DISCOVERY: {
    id: 'MCP-2025-03-26-Authorization-metadata-discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#server-metadata-discovery'
  },
  LEGACY_2025_03_26_AUTH_URL_FALLBACK: {
    id: 'MCP-2025-03-26-Authorization-metadata-url-fallback',
    url: 'https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#fallbacks-for-servers-without-metadata-discovery'
  },
  MCP_PRM_DISCOVERY: {
    id: 'MCP-2025-06-18-PRM-discovery',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#protected-resource-metadata-discovery-requirements'
  },
  MCP_AUTH_DISCOVERY: {
    id: 'MCP-Authorization-metadata-discovery',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-server-metadata-discovery'
  },
  MCP_DCR: {
    id: 'MCP-Dynamic-client-registration',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/client#dynamic-client-registration'
  },
  OAUTH_2_1_AUTHORIZATION_ENDPOINT: {
    id: 'OAUTH-2.1-authorization-endpoint',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#name-authorization-endpoint'
  },
  OAUTH_2_1_TOKEN: {
    id: 'OAUTH-2.1-token-request',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#name-token-request'
  },
  MCP_ACCESS_TOKEN_USAGE: {
    id: 'MCP-Access-token-usage',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#access-token-usage'
  },
  MCP_SCOPE_SELECTION_STRATEGY: {
    id: 'MCP-Scope-selection-strategy',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-selection-strategy'
  },
  MCP_SCOPE_CHALLENGE_HANDLING: {
    id: 'MCP-Scope-challenge-handling',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#scope-challenge-handling'
  },
  MCP_AUTH_ERROR_HANDLING: {
    id: 'MCP-Auth-error-handling',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#error-handling'
  },
  MCP_CLIENT_ID_METADATA_DOCUMENTS: {
    id: 'MCP-Client-ID-Metadata-Documents',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/authorization#client-id-metadata-documents'
  },
  IETF_CIMD: {
    id: 'IETF-OAuth-Client-ID-Metadata-Document',
    url: 'https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00'
  },
  RFC_JWT_CLIENT_AUTH: {
    id: 'RFC-7523-JWT-Client-Auth',
    url: 'https://datatracker.ietf.org/doc/html/rfc7523#section-2.2'
  },
  OAUTH_2_1_CLIENT_CREDENTIALS: {
    id: 'OAUTH-2.1-client-credentials-grant',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#section-4.2'
  },
  SEP_1046_CLIENT_CREDENTIALS: {
    id: 'SEP-1046-Client-Credentials',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/oauth-client-credentials.mdx'
  }
};
