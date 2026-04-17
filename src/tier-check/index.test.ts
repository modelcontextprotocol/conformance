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
});
