/**
 * Integration tests for server conformance `--production` mode and SEP-2549
 * capability-aware caching checks (issue #516).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  printServerSummary,
  runServerConformanceTest
} from '../../runner/server';
import { listActiveClientScenarios } from '../index';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type SpecVersion
} from '../../types';
import {
  runCliSubprocess,
  startStatefulPartialServer,
  startStatelessPartialServer,
  type TestServer
} from './production-mode-fixtures';

describe('server conformance --production mode (stateful 2025-11-25)', () => {
  let activeServer: TestServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = undefined;
    }
  });

  it('preserves strict SDK failures in default mode when capabilities or fixtures are missing', async () => {
    activeServer = await startStatefulPartialServer({
      capabilities: { tools: {} }
    });

    const missingCap = await runServerConformanceTest(
      activeServer.url,
      'resources-list'
    );
    expect(missingCap.checks.some((c) => c.status === 'FAILURE')).toBe(true);

    const missingFixture = await runServerConformanceTest(
      activeServer.url,
      'tools-call-simple-text'
    );
    expect(missingFixture.checks.some((c) => c.status === 'FAILURE')).toBe(
      true
    );
  });

  it('passes active suite against a healthy tools-only production server and skips inapplicable scenarios', async () => {
    activeServer = await startStatefulPartialServer({
      capabilities: { tools: {} }
    });

    const scenarios = listActiveClientScenarios();
    const capabilitiesCache = new Map<SpecVersion, Record<string, unknown>>();
    const allResults: Array<{ scenario: string; checks: ConformanceCheck[] }> =
      [];

    for (const scenario of scenarios) {
      const result = await runServerConformanceTest(
        activeServer.url,
        scenario,
        undefined,
        undefined,
        false,
        10000,
        { production: true, capabilitiesCache }
      );
      allResults.push({ scenario, checks: result.checks });
    }

    const summary = printServerSummary(allResults);
    expect(summary.totalFailed).toBe(0);
    expect(summary.totalPassed).toBeGreaterThan(0);
    expect(summary.totalSkipped).toBeGreaterThan(0);

    const byScenario = new Map(allResults.map((r) => [r.scenario, r.checks]));
    for (const executed of [
      'server-initialize',
      'server-session-lifecycle',
      'ping',
      'dns-rebinding-protection',
      'tools-list',
      'server-sse-multiple-streams'
    ]) {
      const checks = byScenario.get(executed) ?? [];
      expect(
        checks.some((c) => c.status === 'SUCCESS'),
        executed
      ).toBe(true);
      expect(
        checks.some((c) => c.status === 'FAILURE'),
        executed
      ).toBe(false);
    }

    expect(byScenario.get('resources-list')?.[0]).toMatchObject({
      status: 'SKIPPED',
      details: {
        skippedReason: 'missing-capability',
        missingCapabilities: ['resources']
      }
    });
    expect(byScenario.get('tools-call-simple-text')?.[0]).toMatchObject({
      status: 'SKIPPED',
      details: { skippedReason: 'requires-fixture' }
    });
  }, 30000);

  it('still fails in production mode when a server declares resources but fails resources/list', async () => {
    activeServer = await startStatefulPartialServer({
      capabilities: { tools: {}, resources: {} },
      failResourcesList: true
    });

    const result = await runServerConformanceTest(
      activeServer.url,
      'resources-list',
      undefined,
      undefined,
      false,
      10000,
      { production: true }
    );
    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(true);
  });

  it('never falsely skips an unreachable server in production mode', async () => {
    const result = await runServerConformanceTest(
      'http://127.0.0.1:9/mcp',
      'tools-list',
      undefined,
      undefined,
      false,
      5000,
      { production: true }
    );
    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(true);
    expect(result.checks.every((c) => c.status === 'SKIPPED')).toBe(false);
  });
});

describe('SEP-2549 caching and stateless production mode (2026-07-28)', () => {
  let activeServer: TestServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = undefined;
    }
  });

  it('queries only declared capabilities in caching and skips undeclared endpoints', async () => {
    activeServer = await startStatelessPartialServer({
      capabilities: { tools: {} },
      includeCachingHints: true
    });

    const result = await runServerConformanceTest(
      activeServer.url,
      'caching',
      undefined,
      DRAFT_PROTOCOL_VERSION,
      false,
      10000,
      { production: true }
    );

    expect(activeServer.methodsCalled).toContain('tools/list');
    expect(activeServer.methodsCalled).not.toContain('prompts/list');
    expect(activeServer.methodsCalled).not.toContain('resources/list');
    expect(activeServer.methodsCalled).not.toContain(
      'resources/templates/list'
    );
    expect(activeServer.methodsCalled).not.toContain('resources/read');

    const statusById = new Map(result.checks.map((c) => [c.id, c.status]));
    expect(statusById.get('sep-2549-tools-list-caching-hints')).toBe('SUCCESS');
    expect(statusById.get('sep-2549-ttl-non-negative')).toBe('SUCCESS');
    expect(statusById.get('sep-2549-cache-scope-valid')).toBe('SUCCESS');
    expect(statusById.get('sep-2549-prompts-list-caching-hints')).toBe(
      'SKIPPED'
    );
    expect(statusById.get('sep-2549-resources-list-caching-hints')).toBe(
      'SKIPPED'
    );
    expect(
      statusById.get('sep-2549-resources-templates-list-caching-hints')
    ).toBe('SKIPPED');
    expect(statusById.get('sep-2549-resources-read-caching-hints')).toBe(
      'SKIPPED'
    );
  });

  it('fails caching in production mode when declared tools/list omits caching hints', async () => {
    activeServer = await startStatelessPartialServer({
      capabilities: { tools: {} },
      includeCachingHints: false
    });

    const result = await runServerConformanceTest(
      activeServer.url,
      'caching',
      undefined,
      DRAFT_PROTOCOL_VERSION,
      false,
      10000,
      { production: true }
    );
    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(true);
  });

  it('fails empty-capability server on caching in default mode and skips in production mode', async () => {
    activeServer = await startStatelessPartialServer({
      capabilities: {},
      includeCachingHints: false
    });

    const strictResult = await runServerConformanceTest(
      activeServer.url,
      'caching',
      undefined,
      DRAFT_PROTOCOL_VERSION
    );
    expect(strictResult.checks.some((c) => c.status === 'FAILURE')).toBe(true);

    const prodResult = await runServerConformanceTest(
      activeServer.url,
      'caching',
      undefined,
      DRAFT_PROTOCOL_VERSION,
      false,
      10000,
      { production: true }
    );
    expect(prodResult.checks).toHaveLength(1);
    expect(prodResult.checks[0]).toMatchObject({
      id: 'caching',
      status: 'SKIPPED',
      details: {
        skippedReason: 'missing-capability',
        requiredAnyOf: ['tools', 'prompts', 'resources']
      }
    });
  });

  it('runs http-header-validation without invoking tools/call on domain tools in production mode', async () => {
    activeServer = await startStatelessPartialServer({
      capabilities: { tools: {} },
      includeCachingHints: true
    });

    const result = await runServerConformanceTest(
      activeServer.url,
      'http-header-validation',
      undefined,
      DRAFT_PROTOCOL_VERSION,
      false,
      10000,
      { production: true }
    );

    expect(activeServer.methodsCalled).not.toContain('tools/call');
    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(false);
    expect(result.checks.some((c) => c.status === 'SUCCESS')).toBe(true);
    expect(result.checks.some((c) => c.status === 'SKIPPED')).toBe(true);
  });

  it('skips missing diagnostic fixture probes in server-stateless under production mode', async () => {
    activeServer = await startStatelessPartialServer({
      capabilities: { tools: {} },
      includeCachingHints: true
    });

    const result = await runServerConformanceTest(
      activeServer.url,
      'server-stateless',
      undefined,
      DRAFT_PROTOCOL_VERSION,
      false,
      15000,
      { production: true }
    );

    const byId = new Map(result.checks.map((c) => [c.id, c]));
    expect(byId.get('sep-2575-server-implements-discover')?.status).toBe(
      'SUCCESS'
    );
    expect(
      byId.get('sep-2575-server-rejects-undeclared-capability')
    ).toMatchObject({
      status: 'SKIPPED',
      details: {
        skippedReason: 'requires-fixture',
        fixture: 'test_missing_capability'
      }
    });
    expect(byId.get('sep-2575-missing-capability-http-400')?.status).toBe(
      'SKIPPED'
    );
  }, 30000);
});

describe('CLI --production flag', () => {
  let activeServer: TestServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = undefined;
    }
  });

  it('exits 1 without --production and exits 0 with --production on a capability-partial server', async () => {
    activeServer = await startStatefulPartialServer({
      capabilities: { tools: {} }
    });

    const defaultRun = await runCliSubprocess([
      'server',
      '--url',
      activeServer.url,
      '--scenario',
      'resources-list'
    ]);
    expect(defaultRun.exitCode).toBe(1);
    expect(defaultRun.stdout).toContain('Failed Checks');

    const prodScenarioRun = await runCliSubprocess([
      'server',
      '--url',
      activeServer.url,
      '--scenario',
      'resources-list',
      '--production'
    ]);
    expect(prodScenarioRun.exitCode).toBe(0);
    expect(prodScenarioRun.stdout).toContain('1 skipped');

    const prodSuiteRun = await runCliSubprocess([
      'server',
      '--url',
      activeServer.url,
      '--production'
    ]);
    expect(prodSuiteRun.exitCode).toBe(0);
    expect(prodSuiteRun.stdout).toContain('0 failed');
    expect(prodSuiteRun.stdout).toContain('skipped');
  }, 60000);
});
