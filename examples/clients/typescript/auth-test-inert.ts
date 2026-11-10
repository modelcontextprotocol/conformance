#!/usr/bin/env node

import { runAsCli } from './helpers/cliRunner';

/**
 * Broken client that gives up before performing any discovery request.
 *
 * BUG: it never fetches Protected Resource Metadata, so it cannot have
 * validated the `resource` value `auth/resource-mismatch` mismatches on
 * purpose. Pins #467: the negative checks must report this client as
 * untestable, not as having correctly rejected anything.
 */
export async function runClient(_serverUrl: string): Promise<void> {
  throw new Error(
    'inert client: aborted before any discovery request (no PRM fetch, no authorization request)'
  );
}

runAsCli(runClient, import.meta.url, 'auth-test-inert <server-url>');
