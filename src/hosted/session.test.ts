import { describe, it, expect } from 'vitest';
import { SessionManager, type CellRef } from './session';
import { MemoryRunStore } from './store';

const ref: CellRef = {
  runId: 'r1',
  revision: '2025-11-25',
  scenarioName: 'tools_call'
};

describe('SessionManager.persist', () => {
  it('retries saveRun after a failed write so the cell reaches listRuns', async () => {
    let failures = 1;
    let saveRunCalls = 0;
    class FlakyStore extends MemoryRunStore {
      override async saveRun(id: string, scenarioName: string) {
        saveRunCalls++;
        if (failures-- > 0) throw new Error('sqlite 503');
        return super.saveRun(id, scenarioName);
      }
    }
    const store = new FlakyStore();
    const sessions = new SessionManager({ store });
    try {
      const run = sessions.getOrCreate(ref, () => 'http://rs.test/s/x');
      await sessions.persist(run); // saveRun rejects; the error is logged
      expect(run.saved).toBe(false);
      expect(await store.listRuns('r1/')).toEqual([]);

      await sessions.persist(run);
      expect(run.saved).toBe(true);
      expect(await store.listRuns('r1/')).toEqual([
        { id: 'r1/2025-11-25/tools_call', scenarioName: 'tools_call' }
      ]);

      await sessions.persist(run);
      expect(saveRunCalls).toBe(2);
    } finally {
      await sessions.close();
    }
  });
});
