import { SpecReference } from '../../../types';

export const SpecReferences: { [key: string]: SpecReference } = {
  SEP_1932_DPOP: {
    id: 'SEP-1932-DPoP',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1932'
  },
  DPOP_EXTENSION: {
    id: 'MCP-DPoP-Extension',
    url: 'https://github.com/modelcontextprotocol/ext-auth/blob/pieterkas-dpop-extension/specification/draft/dpop-extension.mdx'
  },
  RFC_9449_CHECKING_PROOFS: {
    id: 'RFC-9449-checking-dpop-proofs',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-4.3'
  },
  RFC_9449_AUTH_SCHEME: {
    id: 'RFC-9449-dpop-authentication-scheme',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-7.1'
  },
  RFC_9449_NONCE: {
    id: 'RFC-9449-resource-server-provided-nonce',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-9'
  },
  RFC_9449_ALGORITHMS: {
    id: 'RFC-9449-dpop-proof-jwt-syntax',
    url: 'https://www.rfc-editor.org/rfc/rfc9449.html#section-11.6'
  }
};
