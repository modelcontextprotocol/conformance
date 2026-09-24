#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Well-behaved DPoP client (SEP-1932 / RFC 9449): binds the authorization code
 * to its DPoP key via `dpop_jkt` (RFC 9449 §10), then presents the DPoP-bound
 * token with the `DPoP` Authorization scheme and a fresh proof on every MCP
 * request. It also uses the optional refresh token with a proof for the same
 * key (RFC 9449 §5).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true,
    sendDpopJkt: true,
    exerciseRefresh: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop <server-url>');
