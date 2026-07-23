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
 * Broken client that drops the MCP server URL's query component when
 * constructing the PRM well-known URL.
 * BUG: RFC 9728 §3.1 inserts the well-known suffix between the host and the
 * path AND/OR QUERY components, so for https://host/mcp?tenant=alpha the PRM
 * URL is /.well-known/oauth-protected-resource/mcp?tenant=alpha — this client
 * requests /.well-known/oauth-protected-resource/mcp instead.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const handle401Broken = async (
    response: Response,
    provider: ConformanceOAuthProvider,
    next: FetchLike,
    serverUrl: string | URL
  ): Promise<void> => {
    // BUG: insert the well-known suffix before the path but discard the query
    const url = new URL(serverUrl);
    const resourceMetadataUrl = new URL(
      `/.well-known/oauth-protected-resource${url.pathname}`,
      url.origin
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
    { name: 'test-auth-client-strip-query', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetry(
    'test-auth-client-strip-query',
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

runAsCli(runClient, import.meta.url, 'auth-test-strip-query <server-url>');
