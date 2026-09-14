#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetryWithProvider } from './helpers/withOAuthRetry';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Broken client that re-serializes the protected resource metadata's
 * `resource` through a URL parser before sending it as the RFC 8707
 * `resource` parameter.
 *
 * BUG: `new URL('https://example.com').href` is `https://example.com/`, so a
 * pathless resource identifier gains a trailing slash and no longer matches
 * the value the server published. Authorization servers that compare the
 * indicator exactly (Microsoft Entra ID, AADSTS9010010) reject the request.
 * This is the shape of typescript-sdk#1968 and python-sdk#2578.
 */
class SlashAppendingResourceProvider extends ConformanceOAuthProvider {
  async validateResourceURL(
    _serverUrl: string | URL,
    resource?: string
  ): Promise<URL | undefined> {
    if (!resource) {
      return undefined;
    }
    const url = new URL(resource);
    // BUG: always emit the normalized form with a trailing slash, whatever
    // the server published.
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  }
}

export async function runClient(serverUrl: string): Promise<void> {
  const provider = new SlashAppendingResourceProvider(
    'http://localhost:3000/callback',
    {
      client_name: 'test-auth-client-resource-slash',
      redirect_uris: ['http://localhost:3000/callback'],
      application_type: 'native'
    }
  );

  const client = new Client(
    { name: 'test-auth-client-resource-slash', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetryWithProvider(
    provider,
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

runAsCli(runClient, import.meta.url, 'auth-test-resource-slash <server-url>');
