import { SpecReference } from '../../../types';

export const SpecReferences: { [key: string]: SpecReference } = {
  EMA: {
    id: 'MCP-Enterprise-Managed-Authorization',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx'
  },
  EMA_DISCOVERY: {
    id: 'MCP-Enterprise-Managed-Authorization-Discovery',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx'
  },
  ID_JAG_DISCOVERY: {
    id: 'draft-ietf-oauth-identity-assertion-authz-grant-04-discovery',
    url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-identity-assertion-authz-grant-04.html#section-7.2'
  },
  RFC_7523: {
    id: 'RFC-7523',
    url: 'https://www.rfc-editor.org/rfc/rfc7523.html'
  },
  RFC_6749_TOKEN_RESPONSE: {
    id: 'RFC-6749-5.1',
    url: 'https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1'
  },
  RFC_7521_RESPONSE: {
    id: 'RFC-7521-5.2',
    url: 'https://www.rfc-editor.org/rfc/rfc7521.html#section-5.2'
  },
  RFC_7662_INTROSPECTION: {
    id: 'RFC-7662-2.2',
    url: 'https://www.rfc-editor.org/rfc/rfc7662.html#section-2.2'
  },
  RFC_8707_INVALID_TARGET: {
    id: 'RFC-8707-2.1',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2.1'
  },
  RFC_6749_ERROR_RESPONSE: {
    id: 'RFC-6749-5.2',
    url: 'https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2'
  },
  RFC_7521_INVALID_GRANT: {
    id: 'RFC-7521-4.1.1',
    url: 'https://www.rfc-editor.org/rfc/rfc7521.html#section-4.1.1'
  }
};
