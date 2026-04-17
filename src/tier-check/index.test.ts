import { describe, expect, it } from 'vitest';
import { resolveTierCheckPlan } from './index';

describe('resolveTierCheckPlan', () => {
  it('treats omitted conformance inputs as skipped', () => {
    const plan = resolveTierCheckPlan({});

    expect(plan.runServer).toBe(false);
    expect(plan.runClient).toBe(false);
    expect(plan.serverSkipReason).toBe('no --conformance-server-url');
    expect(plan.clientSkipReason).toBe('no --client-cmd');
    expect(plan.nothingToRun).toBe(false);
  });

  it('reports nothing to run when repo health is also skipped', () => {
    const plan = resolveTierCheckPlan({ skipRepoHealth: true });

    expect(plan.runServer).toBe(false);
    expect(plan.runClient).toBe(false);
    expect(plan.nothingToRun).toBe(true);
  });

  it('respects explicit scope exclusions even when inputs are present', () => {
    const plan = resolveTierCheckPlan({
      conformanceServerUrl: 'http://localhost:3000/mcp',
      clientCmd: 'npm run conformance:client',
      skipClientConformance: true
    });

    expect(plan.runServer).toBe(true);
    expect(plan.runClient).toBe(false);
    expect(plan.clientSkipReason).toBe('excluded by scope');
    expect(plan.nothingToRun).toBe(false);
  });
});
