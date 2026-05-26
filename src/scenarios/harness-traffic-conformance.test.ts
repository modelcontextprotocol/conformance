/**
 * Harness traffic conformance gate: "test conformance with conformance".
 *
 * The harness's own stateless server-scenario drivers (the requests we send
 * when testing an SDK server) must satisfy the cross-cutting client
 * obligations from SEP-2575 and SEP-2243 — otherwise a strictly-conformant SDK
 * rejects harness traffic for reasons unrelated to the behaviour under test
 * (issues #311, #312, #315).
 *
 * Rather than writing bespoke assertions, each pairing starts an existing
 * client-testing Scenario as the judge (a mock server that inspects every
 * incoming request and emits conformance checks) and points a stateless
 * ClientScenario driver at it. The driver's own checks are irrelevant here —
 * the judge's checks are the assertion.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getClientScenario, listDraftClientScenarios } from './index';
import { HttpStandardHeadersScenario } from './client/http-standard-headers';
import { RequestMetadataScenario } from './client/request-metadata';
import type { Scenario } from '../types';

/**
 * judge scenario -> factory.
 *
 * Judges are instantiated fresh for every pairing (the registry instances are
 * module-level singletons whose recorded checks would otherwise leak between
 * pairings).
 */
const JUDGES: Record<string, () => Scenario> = {
  // SEP-2243: Mcp-Method / Mcp-Name headers on every request
  'http-standard-headers': () => new HttpStandardHeadersScenario(),
  // SEP-2575: MCP-Protocol-Version header + complete _meta on every request
  'request-metadata': () => new RequestMetadataScenario()
};

/**
 * Drivers excluded per judge: only scenarios that deliberately send traffic
 * violating that judge's dimension are excluded. Everything else that targets
 * the draft spec is paired automatically (derived from the scenario registry,
 * not hand-listed).
 */
const EXCLUSIONS: Record<string, Set<string>> = {
  'http-standard-headers': new Set([
    // Deliberately sends mismatched/missing Mcp-Method and Mcp-Name headers.
    'http-header-validation',
    // Deliberately sends mismatched/missing Mcp-Name and Mcp-Param-* headers.
    'http-custom-header-server-validation'
  ]),
  'request-metadata': new Set([
    // Deliberately sends requests with missing/invalid _meta and mismatched
    // protocol versions.
    'server-stateless'
    // http-header-validation / http-custom-header-server-validation only
    // mangle the SEP-2243 Mcp-* headers; their MCP-Protocol-Version header and
    // _meta stay conformant, so they are judged here.
  ])
};

describe('harness traffic conformance (drivers judged by client scenarios)', () => {
  let judge: Scenario | undefined;

  afterEach(async () => {
    if (judge) {
      await judge.stop().catch(() => {});
      judge = undefined;
    }
  });

  for (const [judgeName, makeJudge] of Object.entries(JUDGES)) {
    const driverNames = listDraftClientScenarios().filter(
      (name) => !EXCLUSIONS[judgeName].has(name)
    );

    for (const driverName of driverNames) {
      it(`${driverName} traffic passes the ${judgeName} checks`, async () => {
        judge = makeJudge();
        const driver = getClientScenario(driverName);
        expect(driver, `driver scenario ${driverName} not found`).toBeDefined();

        const urls = await judge.start();
        try {
          // The judge's mock is not a real MCP server, so the driver's own
          // checks routinely fail against it — that is expected and ignored.
          // Only the traffic the driver emitted matters here.
          await driver!.run(urls.serverUrl).catch(() => {});
        } finally {
          await judge.stop();
        }

        // WARNING also fails the gate on purpose: SHOULD-level obligations are
        // mandatory for the harness's own traffic.
        const verdicts = judge
          .getChecks()
          .filter((c) => c.status === 'FAILURE' || c.status === 'WARNING');
        expect(
          verdicts,
          `harness traffic from "${driverName}" violated client obligations:\n` +
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
