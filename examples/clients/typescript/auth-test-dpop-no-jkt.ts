#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * DPoP client that omits `dpop_jkt` on the authorization request. Isolates a
 * WARNING of sep-1932-client-dpop-jkt (SEP-1932 / RFC 9449 §10).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true,
    sendDpopJkt: false
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-no-jkt <server-url>');
