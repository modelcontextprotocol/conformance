#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: refreshes without a DPoP proof. Isolates a FAILURE of
 * sep-1932-client-refresh-proof (RFC 9449 §5).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true,
    exerciseRefresh: true,
    sendRefreshProof: false
  });
}

runAsCli(
  runClient,
  import.meta.url,
  'auth-test-dpop-refresh-no-proof <server-url>'
);
