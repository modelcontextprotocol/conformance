/**
 * OAuth client provider and observation middleware for conformance testing.
 *
 * This module provides:
 * 1. A conformance-aware OAuthClientProvider that handles auto-login for testing
 * 2. An observation middleware that records all HTTP requests for conformance checks
 */

import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Middleware } from '@modelcontextprotocol/sdk/client/middleware.js';
import { createMiddleware } from '@modelcontextprotocol/sdk/client/middleware.js';

/**
 * Observed HTTP request/response for conformance checking.
 */
export interface ObservedRequest {
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  /** Parsed WWW-Authenticate header if present */
  wwwAuthenticate?: {
    scheme: string;
    params: Record<string, string>;
  };
  /** Classification of the request type */
  requestType?:
    | 'mcp-request'
    | 'prm-discovery'
    | 'as-metadata'
    | 'dcr-registration'
    | 'token-request'
    | 'authorization'
    | 'unknown';
}

/**
 * Observer callback for recording requests.
 */
export type RequestObserver = (request: ObservedRequest) => void;

/**
 * Parse WWW-Authenticate header value.
 */
function parseWWWAuthenticate(headerValue: string): {
  scheme: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const spaceIndex = headerValue.indexOf(' ');

  if (spaceIndex === -1) {
    return { scheme: headerValue.trim(), params };
  }

  const scheme = headerValue.substring(0, spaceIndex).trim();
  let rest = headerValue.substring(spaceIndex + 1).trim();

  while (rest.length > 0) {
    rest = rest.replace(/^[\s,]+/, '');
    if (rest.length === 0) break;

    const eqMatch = rest.match(/^([^=\s]+)\s*=/);
    if (!eqMatch) break;

    const key = eqMatch[1].toLowerCase();
    rest = rest.substring(eqMatch[0].length).trim();

    let value: string;
    if (rest.startsWith('"')) {
      let endQuote = 1;
      while (endQuote < rest.length) {
        if (rest[endQuote] === '"' && rest[endQuote - 1] !== '\\') break;
        endQuote++;
      }
      value = rest.substring(1, endQuote).replace(/\\"/g, '"');
      rest = rest.substring(endQuote + 1);
    } else {
      const tokenMatch = rest.match(/^([^,\s]+)/);
      value = tokenMatch ? tokenMatch[1] : '';
      rest = rest.substring(value.length);
    }
    params[key] = value;
  }

  return { scheme, params };
}

/**
 * Classify request type based on URL patterns.
 */
function classifyRequest(
  url: string,
  method: string
): ObservedRequest['requestType'] {
  if (url.includes('/.well-known/oauth-protected-resource')) {
    return 'prm-discovery';
  }
  if (
    url.includes('/.well-known/oauth-authorization-server') ||
    url.includes('/.well-known/openid-configuration')
  ) {
    return 'as-metadata';
  }
  if (url.includes('/register') && method === 'POST') {
    return 'dcr-registration';
  }
  if (url.includes('/token') && method === 'POST') {
    return 'token-request';
  }
  if (url.includes('/authorize')) {
    return 'authorization';
  }
  if (url.includes('/mcp') && method === 'POST') {
    return 'mcp-request';
  }
  return 'unknown';
}

/**
 * Creates an observation middleware that records HTTP requests.
 *
 * @param observer - Callback function to receive observed requests
 * @returns Middleware function
 */
export function createObservationMiddleware(
  observer: RequestObserver
): Middleware {
  return createMiddleware(async (next, input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const requestHeaders: Record<string, string> = {};

    if (init?.headers) {
      const headers = new Headers(init.headers);
      headers.forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }

    const response = await next(input, init);

    // Clone response to read body without consuming it
    const clonedResponse = response.clone();
    let responseBody: unknown;
    try {
      const text = await clonedResponse.text();
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } catch {
      // Body not readable
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const observed: ObservedRequest = {
      timestamp: new Date().toISOString(),
      method,
      url,
      requestHeaders,
      responseStatus: response.status,
      responseHeaders,
      responseBody,
      requestType: classifyRequest(url, method)
    };

    // Parse WWW-Authenticate if present
    const wwwAuthHeader = response.headers.get('WWW-Authenticate');
    if (wwwAuthHeader) {
      observed.wwwAuthenticate = parseWWWAuthenticate(wwwAuthHeader);
    }

    observer(observed);
    return response;
  });
}

/**
 * Fixed client metadata URL for CIMD conformance tests.
 * When server supports client_id_metadata_document_supported, this URL
 * will be used as the client_id instead of doing dynamic registration.
 */
const DEFAULT_CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

/**
 * Conformance OAuth client provider for testing.
 *
 * This provider:
 * - Stores client information and tokens in memory
 * - Handles auto-login by fetching the authorization URL and extracting the code from redirect
 * - Uses CIMD (URL-based client IDs) by default when server supports it
 */
export class ConformanceOAuthProvider implements OAuthClientProvider {
  private _clientInformation?: OAuthClientInformationFull;
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _authCode?: string;

  /**
   * URL for Client ID Metadata Document (CIMD/SEP-991).
   * When provided and server advertises client_id_metadata_document_supported,
   * this URL will be used as the client_id instead of DCR.
   */
  readonly clientMetadataUrl?: string;

  constructor(
    private readonly _redirectUrl: string | URL,
    private readonly _clientMetadata: OAuthClientMetadata,
    options?: { clientMetadataUrl?: string }
  ) {
    this.clientMetadataUrl =
      options?.clientMetadataUrl ?? DEFAULT_CIMD_CLIENT_METADATA_URL;
  }

  get redirectUrl(): string | URL {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this._clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this._clientInformation = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  /**
   * Handle authorization redirect by fetching the URL and extracting auth code.
   * This works with auto-login servers that redirect immediately with the code.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    try {
      const response = await fetch(authorizationUrl.toString(), {
        redirect: 'manual' // Don't follow redirects automatically
      });

      // Get the Location header which contains the redirect with auth code
      const location = response.headers.get('location');
      if (location) {
        const redirectUrl = new URL(location);
        const code = redirectUrl.searchParams.get('code');
        if (code) {
          this._authCode = code;
          return;
        }
        throw new Error('No auth code in redirect URL');
      }
      throw new Error(
        `No redirect location received from ${authorizationUrl.toString()}`
      );
    } catch (error) {
      console.error('Failed to fetch authorization URL:', error);
      throw error;
    }
  }

  async getAuthCode(): Promise<string> {
    if (this._authCode) {
      return this._authCode;
    }
    throw new Error('No authorization code');
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }
}
