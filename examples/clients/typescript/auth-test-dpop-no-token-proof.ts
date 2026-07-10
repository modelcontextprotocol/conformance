#!/usr/bin/env node

import { runDpopClient } from './helpers/dpopClientFlow';
import { runAsCli } from './helpers/cliRunner';

/**
 * Broken DPoP client: never sends a DPoP proof at the token endpoint, so it
 * never asks for a sender-constrained token — the AS falls back to an unbound
 * Bearer token. Isolates a failure of sep-1932-client-token-request-proof
 * (RFC 9449 §5). Because the resulting token is unbound, the resource-side
 * binding check (sep-1932-client-fresh-proof) also fails as a consequence.
 */
export async function runClient(serverUrl: string): Promise<void> {
  await runDpopClient(serverUrl, {
    scheme: 'DPoP',
    freshProofPerRequest: true,
    sendTokenRequestProof: false,
    handleAsNonce: true,
    handleRsNonce: true
  });
}

runAsCli(
  runClient,
  import.meta.url,
  'auth-test-dpop-no-token-proof <server-url>'
);
