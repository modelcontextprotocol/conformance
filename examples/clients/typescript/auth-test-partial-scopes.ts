#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withOAuthRetry } from './helpers/withOAuthRetry';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Broken client that only requests a subset of scopes.
 * BUG: Hardcodes a single scope instead of using all from scopes_supported.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const handle401Broken = async (
    response: Response,
    provider: ConformanceOAuthProvider,
    next: FetchLike,
    serverUrl: string | URL
  ): Promise<void> => {
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
    // BUG: Only request one scope instead of all from scopes_supported
    let result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      scope: 'mcp:basic',
      fetchFn: next
    });

    if (result === 'REDIRECT') {
      const authorizationCode = await provider.getAuthCode();
      result = await auth(provider, {
        serverUrl,
        resourceMetadataUrl,
        scope: 'mcp:basic',
        authorizationCode,
        fetchFn: next
      });
      if (result !== 'AUTHORIZED') {
        throw new UnauthorizedError(
          `Authentication failed with result: ${result}`
        );
      }
    }
  };

  const client = new Client(
    { name: 'test-auth-client-broken', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetry(
    'test-auth-client-broken',
    new URL(serverUrl),
    handle401Broken
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('✅ Successfully connected to MCP server');

  await client.listTools();
  logger.debug('✅ Successfully listed tools');

  await transport.close();
  logger.debug('✅ Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test-partial-scopes <server-url>');
