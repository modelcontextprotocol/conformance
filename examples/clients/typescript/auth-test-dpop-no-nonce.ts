#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Nonce-incapable but otherwise compliant DPoP client (SEP-1932 / RFC 9449):
 * presents the DPoP-bound token with the `DPoP` Authorization scheme and a fresh
 * proof on every request, but implements NO `use_dpop_nonce` handling. Against
 * the nonce-less `auth/dpop` scenario (where neither server issues a challenge)
 * it completes the flow successfully — proving that a client which does not
 * support nonces still passes when the server does not require one (the common
 * case, since server nonces are OPTIONAL in RFC 9449 §8/§9).
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: true,
    handleAsNonce: false,
    handleRsNonce: false
  });
}

runAsCli(runClient, import.meta.url, 'auth-test-dpop-no-nonce <server-url>');
