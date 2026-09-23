#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * DPoP client that refreshes an expired access token with a proof for the
 * same key bound at the authorization-code exchange (SEP-1932 / RFC 9449 §5).
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

runAsCli(runClient, import.meta.url, 'auth-test-dpop-refresh <server-url>');
