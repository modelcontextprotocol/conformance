#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry } from './helpers/withOAuthRetry';
import { runAsCli } from './helpers/cliRunner';
import { logger } from './helpers/logger';

/**
 * Non-compliant client that ignores pre-registered credentials and attempts DCR.
 *
 * This client intentionally ignores the client_id and client_secret passed via
 * MCP_CONFORMANCE_CONTEXT and instead attempts to do Dynamic Client Registration.
 * When run against a server that does not support DCR (no registration_endpoint),
 * this client will fail.
 *
 * Used to test that conformance checks detect clients that don't properly
 * use pre-registered credentials when server doesn't support DCR.
 */
export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-auth-client-attempts-dcr', version: '1.0.0' },
    { capabilities: {} }
  );

  // Non-compliant: ignores pre-registered credentials from context
  // and creates a fresh provider that will attempt DCR
  const oauthFetch = withOAuthRetry(
    'test-auth-client-attempts-dcr',
    new URL(serverUrl)
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  logger.debug('Connected to MCP server (attempted DCR instead of pre-reg)');

  await client.listTools();
  logger.debug('Successfully listed tools');

  await client.callTool({ name: 'test-tool', arguments: {} });
  logger.debug('Successfully called tool');

  await transport.close();
  logger.debug('Connection closed successfully');
}

runAsCli(runClient, import.meta.url, 'auth-test-attempts-dcr <server-url>');
