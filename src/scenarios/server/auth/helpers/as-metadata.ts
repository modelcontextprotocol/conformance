/**
 * Authorization Server Metadata helpers.
 *
 * Provides utilities for fetching and validating AS metadata
 * per RFC 8414 and OIDC Discovery.
 */

import { authFetch, buildPrmUrl, AuthTestResult } from './auth-fetch';

/**
 * Result of fetching AS metadata.
 */
export interface AsMetadataResult {
  /** Whether metadata was successfully fetched */
  success: boolean;
  /** The AS metadata document if successful */
  metadata?: Record<string, unknown>;
  /** The URL that was used to fetch metadata */
  url?: string;
  /** Whether OIDC discovery was used (vs RFC 8414) */
  isOidc?: boolean;
  /** URLs that were attempted (in order) */
  triedUrls?: string[];
  /** Error message if fetch failed */
  error?: string;
  /** The AS URL from PRM */
  asUrl?: string;
  /** Raw response for debugging */
  response?: AuthTestResult;
}

export type AsMetadataDiscoveryAttempt = {
  url: string;
  kind: 'RFC8414' | 'OIDC';
  variant: 'root' | 'path-insert' | 'path-append';
};

function trimTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Build the ordered set of AS metadata discovery URLs per MCP auth spec
 * (RFC 8414 + OIDC discovery compatibility).
 *
 * For issuer URLs with path components:
 * 1) RFC 8414 path insertion: <base>/.well-known/oauth-authorization-server<path>
 * 2) OIDC path insertion: <base>/.well-known/openid-configuration<path>
 * 3) OIDC path appending: <base><path>/.well-known/openid-configuration
 *
 * For issuer URLs without path components:
 * 1) RFC 8414: <base>/.well-known/oauth-authorization-server
 * 2) OIDC: <base>/.well-known/openid-configuration
 */
export function buildAsMetadataDiscoveryAttempts(
  asUrl: string
): AsMetadataDiscoveryAttempt[] {
  const parsed = new URL(asUrl);
  const base = `${parsed.protocol}//${parsed.host}`;
  const pathname = parsed.pathname || '/';
  const hasPathComponents = pathname !== '/';

  if (!hasPathComponents) {
    return [
      {
        kind: 'RFC8414',
        variant: 'root',
        url: `${base}/.well-known/oauth-authorization-server`
      },
      {
        kind: 'OIDC',
        variant: 'root',
        url: `${base}/.well-known/openid-configuration`
      }
    ];
  }

  // Path insertion keeps the path as-is (including trailing slash, if any).
  const rfcPathInsert = `${base}/.well-known/oauth-authorization-server${pathname}`;
  const oidcPathInsert = `${base}/.well-known/openid-configuration${pathname}`;

  // Path appending should not produce a double-slash when issuer has a trailing slash.
  const oidcPathAppend = `${base}${trimTrailingSlash(
    pathname
  )}/.well-known/openid-configuration`;

  return [
    { kind: 'RFC8414', variant: 'path-insert', url: rfcPathInsert },
    { kind: 'OIDC', variant: 'path-insert', url: oidcPathInsert },
    { kind: 'OIDC', variant: 'path-append', url: oidcPathAppend }
  ];
}

/**
 * Result of fetching PRM.
 */
export interface PrmResult {
  /** Whether PRM was successfully fetched */
  success: boolean;
  /** The PRM document if successful */
  prm?: Record<string, unknown>;
  /** The URL that was used to fetch PRM */
  url?: string;
  /** Error message if fetch failed */
  error?: string;
  /** Raw response for debugging */
  response?: AuthTestResult;
}

/**
 * Build AS metadata discovery URL.
 */
export function buildAsMetadataUrl(asUrl: string, useOidc: boolean): string {
  const parsed = new URL(asUrl);
  const base = `${parsed.protocol}//${parsed.host}`;
  const pathname = parsed.pathname || '/';

  if (useOidc) {
    // For issuer URLs with path components, prefer the RFC8414 compatibility
    // path-insertion form (clients MUST attempt multiple URLs overall).
    return pathname !== '/'
      ? `${base}/.well-known/openid-configuration${pathname}`
      : `${base}/.well-known/openid-configuration`;
  }
  return pathname !== '/'
    ? `${base}/.well-known/oauth-authorization-server${pathname}`
    : `${base}/.well-known/oauth-authorization-server`;
}

/**
 * Fetch Protected Resource Metadata from a server.
 */
export async function fetchPrm(serverUrl: string): Promise<PrmResult> {
  const pathBasedUrl = buildPrmUrl(serverUrl, true);
  const rootUrl = buildPrmUrl(serverUrl, false);

  // Try path-based first
  try {
    const response = await authFetch(pathBasedUrl);
    if (
      response.status === 200 &&
      typeof response.body === 'object' &&
      response.body !== null
    ) {
      return {
        success: true,
        prm: response.body as Record<string, unknown>,
        url: pathBasedUrl,
        response
      };
    }
  } catch {
    // Will try root
  }

  // Try root
  if (pathBasedUrl !== rootUrl) {
    try {
      const response = await authFetch(rootUrl);
      if (
        response.status === 200 &&
        typeof response.body === 'object' &&
        response.body !== null
      ) {
        return {
          success: true,
          prm: response.body as Record<string, unknown>,
          url: rootUrl,
          response
        };
      }
    } catch {
      // Both failed
    }
  }

  return {
    success: false,
    error: `No valid PRM found at ${pathBasedUrl} or ${rootUrl}`
  };
}

/**
 * Fetch Authorization Server metadata from the AS referenced in PRM.
 *
 * @param serverUrl - The MCP server URL
 * @returns AS metadata result
 */
export async function fetchAsMetadata(
  serverUrl: string
): Promise<AsMetadataResult> {
  // First fetch PRM
  const prmResult = await fetchPrm(serverUrl);

  if (!prmResult.success || !prmResult.prm) {
    return {
      success: false,
      error: prmResult.error || 'Failed to fetch PRM'
    };
  }

  const authServers = prmResult.prm.authorization_servers as
    | string[]
    | undefined;

  if (!Array.isArray(authServers) || authServers.length === 0) {
    return {
      success: false,
      error: 'PRM missing authorization_servers array'
    };
  }

  const asUrl = authServers[0];

  const attempts = buildAsMetadataDiscoveryAttempts(asUrl);
  const triedUrls: string[] = [];

  for (const attempt of attempts) {
    triedUrls.push(attempt.url);
    try {
      const response = await authFetch(attempt.url);
      if (
        response.status === 200 &&
        typeof response.body === 'object' &&
        response.body !== null
      ) {
        return {
          success: true,
          metadata: response.body as Record<string, unknown>,
          url: attempt.url,
          isOidc: attempt.kind === 'OIDC',
          asUrl,
          triedUrls,
          response
        };
      }
    } catch {
      // Try next attempt
    }
  }

  return {
    success: false,
    error: `No AS metadata found at ${triedUrls.join(' or ')}`,
    asUrl,
    triedUrls
  };
}
