#!/usr/bin/env node

/**
 * Broken WIF client: requests a scope the AS does not permit for JWT-bearer grant.
 * BUG: Includes 'wif.rejected' in the scope parameter — AS returns invalid_scope.
 */

import { runWifJwtBearerScopeRejected } from './wif-broken-clients.js';
import { runAsCli } from './helpers/cliRunner.js';

runAsCli(
  runWifJwtBearerScopeRejected,
  import.meta.url,
  'auth-test-wif-scope-rejected <server-url>'
);
