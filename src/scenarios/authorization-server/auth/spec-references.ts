import { SpecReference } from '../../../types';

export const SpecReferences: { [key: string]: SpecReference } = {
  MCP_AUTH_DISCOVERY: {
    id: 'MCP-Authorization-metadata-discovery',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-metadata-discovery'
  },
  OAUTH_2_1_AUTHORIZATION_CODE_GRANT: {
    id: 'OAUTH-2.1-authorization-code-grant',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#section-4.1'
  },
  // DPoP (SEP-1932 / RFC 9449) — authorization-server concerns.
  SEP_1932_DPOP: {
    id: 'SEP-1932-DPoP',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1932'
  },
  DPOP_EXTENSION: {
    id: 'MCP-DPoP-Extension',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/pieterkas-dpop-extension/specification/draft/dpop-extension.mdx'
  },
  RFC_9449_AS_METADATA: {
    id: 'RFC-9449-authorization-server-metadata',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-5.1'
  },
  RFC_9449_PUBLIC_KEY_CONFIRMATION: {
    id: 'RFC-9449-public-key-confirmation',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-6'
  },
  RFC_9449_ALGORITHMS: {
    id: 'RFC-9449-dpop-proof-jwt-syntax',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-11.6'
  }
};
