/**
 * Draft self-conformance gate: "test conformance with conformance".
 *
 * The harness's own draft-spec server-scenario drivers (the requests we send
 * when testing an SDK server) must satisfy the cross-cutting draft client
 * obligations — otherwise a strictly-conformant SDK rejects harness traffic
 * for reasons unrelated to the behaviour under test (issues #311, #312, #315).
 *
 * Rather than writing bespoke assertions, each pairing starts an existing
 * client-testing Scenario as the judge (a mock server that inspects every
 * incoming request and emits conformance checks) and points a draft
 * ClientScenario driver at it. The driver's own checks are irrelevant here —
 * the judge's checks are the assertion.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getClientScenario } from './index';
import { HttpStandardHeadersScenario } from './client/http-standard-headers';
import { RequestMetadataScenario } from './client/request-metadata';
import type { Scenario } from '../types';

/**
 * judge scenario -> driver scenarios.
 *
 * Judges are instantiated fresh for every pairing (the registry instances are
 * module-level singletons whose recorded checks would otherwise leak between
 * pairings).
 *
 * Only positive draft drivers are paired with a given judge: scenarios that
 * deliberately send traffic violating that judge's dimension (e.g.
 * server-stateless's invalid-_meta cases against the SEP-2575 judge, or
 * http-header-validation's mangled headers against the SEP-2243 judge) are
 * excluded from that judge's row.
 */
const JUDGES: Record<string, () => Scenario> = {
  // SEP-2243: Mcp-Method / Mcp-Name headers on every request
  'http-standard-headers': () => new HttpStandardHeadersScenario(),
  // SEP-2575: MCP-Protocol-Version header + complete _meta on every request
  'request-metadata': () => new RequestMetadataScenario()
};

const PAIRINGS: Record<string, string[]> = {
  'http-standard-headers': [
    'caching',
    'input-required-result-basic-elicitation',
    'sep-2164-resource-not-found',
    'server-stateless'
  ],
  'request-metadata': [
    'caching',
    'input-required-result-basic-elicitation',
    'sep-2164-resource-not-found'
  ]
};

describe('draft self-conformance (harness traffic judged by client scenarios)', () => {
  let judge: Scenario | undefined;

  afterEach(async () => {
    if (judge) {
      await judge.stop().catch(() => {});
      judge = undefined;
    }
  });

  for (const [judgeName, driverNames] of Object.entries(PAIRINGS)) {
    for (const driverName of driverNames) {
      it(`${driverName} traffic passes the ${judgeName} checks`, async () => {
        judge = JUDGES[judgeName]();
        expect(judge, `judge scenario ${judgeName} not found`).toBeDefined();
        const driver = getClientScenario(driverName);
        expect(driver, `driver scenario ${driverName} not found`).toBeDefined();

        const urls = await judge!.start();
        try {
          // The judge's mock is not a real MCP server, so the driver's own
          // checks routinely fail against it — that is expected and ignored.
          // Only the traffic the driver emitted matters here.
          await driver!.run(urls.serverUrl).catch(() => {});
        } finally {
          await judge!.stop();
        }

        const verdicts = judge!
          .getChecks()
          .filter((c) => c.status === 'FAILURE' || c.status === 'WARNING');
        expect(
          verdicts,
          `harness traffic from "${driverName}" violated draft client obligations:\n` +
            verdicts
              .map(
                (c) =>
                  `  ${c.id} [${c.status}] ${c.name}: ${c.errorMessage ?? c.description}`
              )
              .join('\n')
        ).toEqual([]);
      }, 30000);
    }
  }
});
