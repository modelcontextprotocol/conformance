#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: builds correct per-request proofs but presents the
 * DPoP-bound token with the `Bearer` scheme instead of `DPoP`. Isolates a
 * failure of sep-1932-client-dpop-auth-scheme (RFC 9449 §7.1).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'Bearer',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-bearer <server-url>');
