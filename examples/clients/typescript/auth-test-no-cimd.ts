#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry } from './helpers/withOAuthRetry';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Non-compliant client that doesn't use CIMD (Client ID Metadata Document).
 * 
 * This client intentionally omits the clientMetadataUrl parameter when the server
 * advertises client_id_metadata_document_supported=true. A compliant client should
 * use CIMD when the server supports it, but this client falls back to DCR (Dynamic
 * Client Registration) instead.
 * 
 * Used to test that conformance checks detect clients that don't properly
 * implement CIMD support.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client-no-cimd', version: '1.0.0' },
    { capabilities: {} }
  );

  // Non-compliant: omitting clientMetadataUrl causes fallback to DCR
  // A compliant client would pass a clientMetadataUrl here when the server
  // advertises client_id_metadata_document_supported=true
  const oauthFetch = withOAuthRetry(
    'test-auth-client-no-cimd',
    new URL(serverUrl)
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
