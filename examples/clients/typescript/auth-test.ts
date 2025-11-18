#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry, handle401 } from './helpers/withOAuthRetry.js';
import { runAsCli } from './helpers/cliRunner.js';
import { logger } from './helpers/logger.js';

/**
 * Fixed client metadata URL for CIMD conformance tests.
 * When server supports client_id_metadata_document_supported, this URL
 * will be used as the client_id instead of doing dynamic registration.
 */
const CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

/**
 * Well-behaved auth client that follows all OAuth protocols correctly.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetry(
    'test-auth-client',
    new URL(serverUrl),
    handle401,
    CIMD_CLIENT_METADATA_URL
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('✅ Successfully connected to MCP server');

  await client.listTools();
  logger.debug('✅ Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('✅ Successfully called tool');

  await transport.close();
  logger.debug('✅ Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test <server-url>');
