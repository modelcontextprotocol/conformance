#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Well-behaved DPoP client (SEP-1932 / RFC 9449): presents the DPoP-bound token
 * with the `DPoP` Authorization scheme and a fresh proof on every MCP request.
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop <server-url>');
