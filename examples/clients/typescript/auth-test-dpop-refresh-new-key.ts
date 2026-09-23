#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: refreshes with a DPoP proof for a different key than
 * the one bound at the authorization-code exchange. Isolates a FAILURE of
 * sep-1932-client-refresh-proof (RFC 9449 §5).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true,
    sendDpopJkt: true,
    exerciseRefresh: true,
    refreshWithNewKey: true
  });
}

runAsCli(
  runClient,
  import.meta.url,
  'auth-test-dpop-refresh-new-key <server-url>'
);
