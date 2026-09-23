#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * DPoP client that recovers from access-token expiry by running a new
 * authorization_code flow instead of refreshing. sep-1932-client-refresh-proof
 * is INFO: re-authorization is permitted and is not a DPoP violation.
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
    onExpiry: 'reauthorize'
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-reauth <server-url>');
