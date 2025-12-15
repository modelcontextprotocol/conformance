#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Middleware } from '@modelcontextprotocol/sdk/client/middleware.js';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Broken client that retries auth infinitely without any retry limit.
 * BUG: Does not implement retry limits, causing infinite auth loops.
 */

const withOAuthRetryNoLimit = (
  clientName: string,
  baseUrl?: string | URL
): Middleware => {
  const provider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: clientName,
      redirect_uris: ['http://localhost:3000/callback']
    }
  );

  return (next: FetchLike) => {
    return async (
      input: string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const makeRequest = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const tokens = await provider.tokens();
        if (tokens) {
          headers.set('Authorization', `Bearer ${tokens.access_token}`);
        }
        return await next(input, { ...init, headers });
      };

      let response = await makeRequest();

      // BUG: No retry limit - keeps retrying on every 401/403
      while (response.status === 401 || response.status === 403) {
        const serverUrl =
          baseUrl ||
          (typeof input === 'string' ? new URL(input).origin : input.origin);

        const { resourceMetadataUrl, scope } =
          extractWWWAuthenticateParams(response);
        let result = await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          scope,
          fetchFn: next
        });

        if (result === 'REDIRECT') {
          const authorizationCode = await provider.getAuthCode();
          result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope,
            authorizationCode,
            fetchFn: next
          });
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }

        response = await makeRequest();
      }

      return response;
    };
  };
};

export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client-no-retry-limit', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetryNoLimit(
    'test-auth-client-no-retry-limit',
    new URL(serverUrl)
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

runAsCli(runClient, import.meta.url, 'auth-test-no-retry-limit <server-url>');
