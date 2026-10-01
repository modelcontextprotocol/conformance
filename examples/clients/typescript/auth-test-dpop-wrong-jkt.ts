#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: sends a `dpop_jkt` that does not match the DPoP proof
 * key used at the token endpoint. Isolates a FAILURE of
 * sep-1932-client-dpop-jkt; the test AS rejects the token request with 400
 * `invalid_grant` (RFC 9449 §10).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: true,
    handleRsNonce: true,
    wrongDpopJkt: true
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-wrong-jkt <server-url>');
