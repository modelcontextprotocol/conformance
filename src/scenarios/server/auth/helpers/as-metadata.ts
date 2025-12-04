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
  /** Error message if fetch failed */
  error?: string;
  /** The AS URL from PRM */
  asUrl?: string;
  /** Raw response for debugging */
  response?: AuthTestResult;
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

  if (useOidc) {
    return `${base}/.well-known/openid-configuration`;
  }
  return `${base}/.well-known/oauth-authorization-server`;
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

  // Try RFC 8414 first
  const rfc8414Url = buildAsMetadataUrl(asUrl, false);
  try {
    const response = await authFetch(rfc8414Url);
    if (
      response.status === 200 &&
      typeof response.body === 'object' &&
      response.body !== null
    ) {
      return {
        success: true,
        metadata: response.body as Record<string, unknown>,
        url: rfc8414Url,
        isOidc: false,
        asUrl,
        response
      };
    }
  } catch {
    // Will try OIDC
  }

  // Try OIDC Discovery
  const oidcUrl = buildAsMetadataUrl(asUrl, true);
  try {
    const response = await authFetch(oidcUrl);
    if (
      response.status === 200 &&
      typeof response.body === 'object' &&
      response.body !== null
    ) {
      return {
        success: true,
        metadata: response.body as Record<string, unknown>,
        url: oidcUrl,
        isOidc: true,
        asUrl,
        response
      };
    }
  } catch {
    // Both failed
  }

  return {
    success: false,
    error: `No AS metadata found at ${rfc8414Url} or ${oidcUrl}`,
    asUrl
  };
}
