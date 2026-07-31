#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: uses the DPoP scheme correctly but reuses a single proof
 * (same `jti`) across requests instead of a fresh one each time. Isolates a
 * failure of sep-1932-client-fresh-proof.
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: false,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-replay <server-url>');
