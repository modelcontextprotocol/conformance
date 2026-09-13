/**
 * The everything-client's SEP-2243 handlers, run in-process against each
 * header scenario's server with the environment the CLI runner would set
 * (context including the scenario's steps), must pass every check.
 */
import { describe, expect, test } from 'vitest';
import { getHandler } from './everything-client';
import { getScenario } from '../../../src/scenarios/index';
import { testScenarioContext } from '../../../src/mock-server/testing';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck
} from '../../../src/types';

async function runAgainst(name: string): Promise<ConformanceCheck[]> {
  const handler = getHandler(name);
  const scenario = getScenario(name);
  if (!handler || !scenario) throw new Error(`${name}: no handler or scenario`);
  const urls = await scenario.start(
    testScenarioContext(DRAFT_PROTOCOL_VERSION)
  );
  // Mirrors src/runner/client.ts: context from start(), plus the steps.
  const context =
    scenario.steps || urls.context
      ? { ...urls.context, ...(scenario.steps && { steps: scenario.steps }) }
      : undefined;
  process.env.MCP_CONFORMANCE_SCENARIO = name;
  process.env.MCP_CONFORMANCE_PROTOCOL_VERSION = DRAFT_PROTOCOL_VERSION;
  if (context) {
    process.env.MCP_CONFORMANCE_CONTEXT = JSON.stringify({ name, ...context });
  }
  try {
    await handler(urls.serverUrl);
    return scenario.getChecks();
  } finally {
    delete process.env.MCP_CONFORMANCE_SCENARIO;
    delete process.env.MCP_CONFORMANCE_PROTOCOL_VERSION;
    delete process.env.MCP_CONFORMANCE_CONTEXT;
    await scenario.stop();
  }
}

describe('everything-client SEP-2243 header handlers', () => {
  test.each([
    'http-standard-headers',
    'http-custom-headers',
    'http-invalid-tool-headers'
  ])('passes %s', async (name) => {
    const checks = await runAgainst(name);
    const judged = checks.filter((c) => c.status !== 'INFO');
    expect(judged.length).toBeGreaterThan(0);
    for (const check of judged) {
      expect(
        check.status,
        `${check.id} ${check.name}: ${check.errorMessage ?? ''}`
      ).toBe('SUCCESS');
    }
  });
});
