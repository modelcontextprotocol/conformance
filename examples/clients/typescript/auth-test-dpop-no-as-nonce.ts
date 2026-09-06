#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: ignores the authorization server's `use_dpop_nonce`
 * challenge at the token endpoint (RFC 9449 §8) — it does not retry the token
 * request with the supplied nonce. Isolates a failure of
 * sep-1932-client-as-nonce.
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: false,
    handleRsNonce: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-no-as-nonce <server-url>');
