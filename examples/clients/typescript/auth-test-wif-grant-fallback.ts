#!/usr/bin/env node

/**
 * Broken WIF client: falls back to authorization_code after receiving unauthorized_client.
 * BUG: switches grant type instead of surfacing the error.
 */

import { runWifJwtBearerGrantFallback } from './wif-broken-clients.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerGrantFallback,
  import.meta.url,
  'auth-test-wif-grant-fallback <server-url>'
);
