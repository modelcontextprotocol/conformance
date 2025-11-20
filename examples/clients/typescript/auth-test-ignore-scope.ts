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
 * Broken client that ignores the scope from WWW-Authenticate header.
 * BUG: Doesn't pass the scope parameter from the 401 response.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const handle401Broken = async (
    response: Response,
    provider: ConformanceOAuthProvider,
    next: FetchLike,
    serverUrl: string | URL
  ): Promise<void> => {
    // BUG: Don't read the scope from the header
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
    let result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      // scope deliberately omitted
      fetchFn: next
    });

    if (result === 'REDIRECT') {
      const authorizationCode = await provider.getAuthCode();
      result = await auth(provider, {
        serverUrl,
        resourceMetadataUrl,
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

runAsCli(runClient, import.meta.url, 'auth-test-ignore-scope <server-url>');
