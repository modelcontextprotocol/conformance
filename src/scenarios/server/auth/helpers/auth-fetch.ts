/**
 * Low-level HTTP utilities for OAuth conformance testing.
 *
 * This module provides raw HTTP fetch capabilities without using the MCP SDK,
 * allowing us to test edge cases and validate HTTP-level OAuth behavior.
 */

/**
 * Parsed WWW-Authenticate header components.
 *
 * @see RFC 7235 Section 4.1
 * @see RFC 6750 Section 3 (Bearer Token Usage)
 */
export interface ParsedWWWAuthenticate {
  /** Authentication scheme (e.g., "Bearer") */
  scheme: string;
  /** Key-value parameters from the challenge */
  params: Record<string, string>;
  /** Raw header value for debugging */
  raw: string;
}

/**
 * Result of an auth-aware HTTP request.
 */
export interface AuthTestResult {
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
  /** Parsed response body (JSON if applicable) */
  body: unknown;
  /** Raw response body string */
  rawBody: string;
  /** Parsed WWW-Authenticate header if present */
  wwwAuthenticate?: ParsedWWWAuthenticate;
}

/**
 * Options for auth-aware fetch requests.
 */
export interface AuthFetchOptions {
  /** Bearer token to include in Authorization header */
  token?: string;
  /** HTTP method (defaults to GET) */
  method?: string;
  /** Request body (will be JSON-serialized) */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Parse a WWW-Authenticate header value per RFC 7235.
 *
 * Handles the Bearer challenge format:
 *   Bearer realm="example", scope="read write", error="invalid_token"
 *
 * @param headerValue - The raw WWW-Authenticate header value
 * @returns Parsed challenge with scheme and parameters
 */
export function parseWWWAuthenticate(
  headerValue: string
): ParsedWWWAuthenticate {
  const raw = headerValue;
  const params: Record<string, string> = {};

  // Extract scheme (first token before space)
  const spaceIndex = headerValue.indexOf(' ');
  let scheme: string;
  let rest: string;

  if (spaceIndex === -1) {
    // No parameters, just scheme
    scheme = headerValue.trim();
    rest = '';
  } else {
    scheme = headerValue.substring(0, spaceIndex).trim();
    rest = headerValue.substring(spaceIndex + 1).trim();
  }

  // Parse parameters: key="value" or key=value, comma-separated
  // RFC 7235 allows both quoted and unquoted values
  if (rest) {
    // State machine for parsing auth-param list
    let current = rest;

    while (current.length > 0) {
      // Skip whitespace and commas
      current = current.replace(/^[\s,]+/, '');
      if (current.length === 0) break;

      // Extract key (token before =)
      const eqMatch = current.match(/^([^=\s]+)\s*=/);
      if (!eqMatch) break;

      const key = eqMatch[1].toLowerCase();
      current = current.substring(eqMatch[0].length).trim();

      // Extract value (quoted or unquoted)
      let value: string;

      if (current.startsWith('"')) {
        // Quoted string - find closing quote (handling escaped quotes)
        let endQuote = 1;
        while (endQuote < current.length) {
          if (current[endQuote] === '"' && current[endQuote - 1] !== '\\') {
            break;
          }
          endQuote++;
        }
        value = current.substring(1, endQuote).replace(/\\"/g, '"');
        current = current.substring(endQuote + 1);
      } else {
        // Unquoted token - read until comma or whitespace
        const tokenMatch = current.match(/^([^,\s]+)/);
        value = tokenMatch ? tokenMatch[1] : '';
        current = current.substring(value.length);
      }

      params[key] = value;
    }
  }

  return { scheme, params, raw };
}

/**
 * Perform an HTTP request with optional Bearer token authentication.
 *
 * @param url - URL to fetch
 * @param options - Request options including optional token
 * @returns AuthTestResult with status, headers, body, and parsed WWW-Authenticate
 */
export async function authFetch(
  url: string,
  options: AuthFetchOptions = {}
): Promise<AuthTestResult> {
  const { token, method = 'GET', body, headers = {}, timeout = 30000 } = options;

  // Build headers
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers
  };

  if (token) {
    requestHeaders['Authorization'] = `Bearer ${token}`;
  }

  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Read response body
    const rawBody = await response.text();
    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }

    // Parse WWW-Authenticate if present
    let wwwAuthenticate: ParsedWWWAuthenticate | undefined;
    const wwwAuthHeader = response.headers.get('WWW-Authenticate');
    if (wwwAuthHeader) {
      wwwAuthenticate = parseWWWAuthenticate(wwwAuthHeader);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: parsedBody,
      rawBody,
      wwwAuthenticate
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Extract the base URL from a full URL (removes path).
 *
 * @param url - Full URL
 * @returns Base URL (scheme + host + port)
 */
export function getBaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Build a well-known URL for Protected Resource Metadata.
 *
 * Per RFC 9728, PRM can be at:
 * - /.well-known/oauth-protected-resource (root)
 * - /.well-known/oauth-protected-resource/<path> (path-based)
 *
 * @param serverUrl - The MCP server URL
 * @param pathBased - Whether to use path-based PRM URL
 * @returns Well-known URL for PRM
 */
export function buildPrmUrl(serverUrl: string, pathBased: boolean): string {
  const parsed = new URL(serverUrl);
  const base = `${parsed.protocol}//${parsed.host}`;

  if (pathBased && parsed.pathname !== '/') {
    // Path-based: /.well-known/oauth-protected-resource/<path>
    return `${base}/.well-known/oauth-protected-resource${parsed.pathname}`;
  } else {
    // Root: /.well-known/oauth-protected-resource
    return `${base}/.well-known/oauth-protected-resource`;
  }
}
