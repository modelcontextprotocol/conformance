#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry } from './helpers/withOAuthRetry.js';
import { runAsCli } from './helpers/cliRunner.js';
import { logger } from './helpers/logger.js';

/**
 * Client that doesn't use CIMD even when server supports it.
 * BUG: Doesn't provide clientMetadataUrl, so falls back to DCR.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client-no-cimd', version: '1.0.0' },
    { capabilities: {} }
  );

  // BUG: Not passing clientMetadataUrl, so client will use DCR
  // even when server supports client_id_metadata_document_supported
  const oauthFetch = withOAuthRetry(
    'test-auth-client-no-cimd',
    new URL(serverUrl)
    // Missing: handle401, clientMetadataUrl
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('Connected to MCP server (without CIMD)');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test-no-cimd <server-url>');
