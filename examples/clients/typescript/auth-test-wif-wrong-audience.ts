#!/usr/bin/env node

/**
 * Broken WIF client: presents a JWT with the wrong audience.
 * BUG: Uses wrong_audience_jwt instead of valid_jwt — server rejects with invalid_grant.
 */

import { runWifJwtBearerWrongAudience } from './wif-broken-clients.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerWrongAudience,
  import.meta.url,
  'auth-test-wif-wrong-audience <server-url>'
);
