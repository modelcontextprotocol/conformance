#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: obtains the token correctly (handles the AS nonce) but
 * ignores the MCP server's `use_dpop_nonce` challenge at the resource
 * (RFC 9449 §9) — it does not retry the request with the supplied nonce.
 * Isolates a failure of sep-1932-client-rs-nonce.
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: false
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-no-rs-nonce <server-url>');
