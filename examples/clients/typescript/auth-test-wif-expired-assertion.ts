#!/usr/bin/env node

/**
 * Broken WIF client: presents a JWT that is already expired.
 * BUG: Uses expired_jwt instead of valid_jwt — server rejects with invalid_grant.
 */

import { runWifJwtBearerExpiredAssertion } from './wif-broken-clients.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerExpiredAssertion,
  import.meta.url,
  'auth-test-wif-expired-assertion <server-url>'
);
