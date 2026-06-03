#!/usr/bin/env node

/**
 * Broken WIF client: retries JWT-bearer after receiving unauthorized_client.
 * BUG: retries instead of surfacing the error.
 */

import { runWifJwtBearerRetry } from './wif-broken-clients.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerRetry,
  import.meta.url,
  'auth-test-wif-retry <server-url>'
);
