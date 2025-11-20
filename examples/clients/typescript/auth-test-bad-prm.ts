#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withOAuthRetry } from './helpers/withOAuthRetry';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Broken client that always uses root-based PRM discovery.
 * BUG: Ignores the resource_metadata URL from WWW-Authenticate header.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const handle401Broken = async (
    response: Response,
    provider: ConformanceOAuthProvider,
    next: FetchLike,
    serverUrl: string | URL
  ): Promise<void> => {
    // BUG: Use root-based PRM discovery exclusively
    const resourceMetadataUrl = new URL(
      '/.well-known/oauth-protected-resource',
      typeof serverUrl === 'string' ? serverUrl : serverUrl.origin
    );

    let result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
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

runAsCli(runClient, import.meta.url, 'auth-test-bad-prm <server-url>');
