#!/usr/bin/env node

import { runAsCli } from './helpers/cliRunner';

/**
 * Broken client that gives up before performing any discovery request.
 *
 * BUG: it never fetches Protected Resource Metadata, so it never reads — let
 * alone validates — the `resource` value the scenario mismatches on purpose.
 *
 * It exists to pin issue #467. `auth/resource-mismatch` decides its verdict
 * from `!authorizationRequestMade` alone, and a client that does nothing at
 * all satisfies that verdict, so the check scores SUCCESS for a client that
 * cannot possibly have performed the validation under test.
 */
export async function runClient(_serverUrl: string): Promise<void> {
  throw new Error(
    'inert client: aborted before any discovery request (no PRM fetch, no authorization request)'
  );
}

runAsCli(runClient, import.meta.url, 'auth-test-inert <server-url>');
