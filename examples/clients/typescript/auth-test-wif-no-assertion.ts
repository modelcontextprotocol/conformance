#!/usr/bin/env node

/**
 * Broken WIF client: omits the assertion parameter from the token request.
 * BUG: Does not include assertion in JWT-bearer grant — server rejects with invalid_request.
 */

import { runWifJwtBearerMissingAssertion } from './everything-client.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerMissingAssertion,
  import.meta.url,
  'auth-test-wif-no-assertion <server-url>'
);
