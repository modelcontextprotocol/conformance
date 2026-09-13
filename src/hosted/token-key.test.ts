import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionManager } from './session';
import { MemoryRunStore, type RunStore } from './store';
import {
  MockTokenVerifier,
  tokenWithScopes
} from '../scenarios/client/auth/helpers/mockTokenVerifier';

const REV = '2026-07-28';

/**
 * The key auth tokens are signed with is made once per deployment and
 * shared through the run store, so any process verifies a token another
 * minted; a process that cannot share it says so at startup.
 */
describe("the deployment's key for auth tokens", () => {
  const managers: SessionManager[] = [];
  const manager = (store?: RunStore) => {
    const m = new SessionManager({ store });
    managers.push(m);
    return m;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(managers.splice(0).map((m) => m.close()));
  });

  const scopesOf = async (token: string, verifier: SessionManager) =>
    (
      await new MockTokenVerifier(
        [],
        [],
        verifier.scenarioContext(REV).tokenMacKey
      ).verifyAccessToken(token)
    ).scopes;

  it("lets two processes sharing a store verify each other's tokens", async () => {
    const store = new MemoryRunStore();
    const [a, b] = [manager(store), manager(store)];
    await Promise.all([a.ready(), b.ready()]);
    const key = a.scenarioContext(REV).tokenMacKey;
    expect(key).toBeDefined();
    const token = tokenWithScopes('test-token-a', ['mcp:basic'], key);
    expect(await scopesOf(token, b)).toEqual(['mcp:basic']);

    // A process on another store has another key.
    const other = manager(new MemoryRunStore());
    await other.ready();
    expect(await scopesOf(token, other)).toEqual([]);
  });

  it('warns once, without the key, when the store cannot share one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plain = new MemoryRunStore();
    const noSecrets: RunStore = {
      saveRun: (...a) => plain.saveRun(...a),
      loadRun: (...a) => plain.loadRun(...a),
      listRuns: (...a) => plain.listRuns(...a),
      saveChecks: (...a) => plain.saveChecks(...a),
      loadChecks: (...a) => plain.loadChecks(...a),
      deleteRun: (...a) => plain.deleteRun(...a)
    };
    await manager(noSecrets).ready();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'could not share a key for auth tokens'
    );

    warn.mockClear();
    await manager(new MemoryRunStore()).ready();
    await manager().ready();
    expect(warn).not.toHaveBeenCalled();
  });
});
