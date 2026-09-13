import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'http';
import { SessionManager } from './session';
import { createHostedApp } from './server';
import { MemoryRunStore, type RunStore } from './store';
import {
  MockTokenVerifier,
  tokenWithScopes
} from '../scenarios/client/auth/helpers/mockTokenVerifier';

const REV = '2026-07-28';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store whose shared-secret call never answers (a hung cold start). */
class HangingStore extends MemoryRunStore {
  sharedSecret(): Promise<string> {
    return new Promise(() => {});
  }
}

/** A store whose shared-secret call fails `failures` times first (a 503). */
class FlakyStore extends MemoryRunStore {
  constructor(private failures: number) {
    super();
  }
  async sharedSecret(name: string, create: () => string): Promise<string> {
    if (this.failures-- > 0) throw new Error('sqlite 503: try again');
    return super.sharedSecret(name, create);
  }
}

/** A store that answers only after `ms`, and remembers what it stored. */
class SlowStore extends MemoryRunStore {
  stored: string | undefined;
  constructor(private ms: number) {
    super();
  }
  async sharedSecret(name: string, create: () => string): Promise<string> {
    await sleep(this.ms);
    return (this.stored = await super.sharedSecret(name, create));
  }
}

/** A store whose errors quote the statement, key included. */
class LeakyStore extends MemoryRunStore {
  seen: string | undefined;
  async sharedSecret(_name: string, create: () => string): Promise<string> {
    this.seen = create();
    throw new Error(`insert failed: VALUES ('token-mac-key', '${this.seen}')`);
  }
}

/**
 * The key auth tokens are signed with is made once per deployment and
 * shared through the run store, so any process verifies a token another
 * minted; a process that cannot share it says so at startup.
 */
describe("the deployment's key for auth tokens", () => {
  const managers: SessionManager[] = [];
  const manager = (store?: RunStore, tokenKeyBudgetMs?: number) => {
    const m = new SessionManager({ store, tokenKeyBudgetMs });
    managers.push(m);
    return m;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(managers.splice(0).map((m) => m.close()));
  });

  const keyOf = (m: SessionManager) => m.scenarioContext(REV).tokenMacKey;

  const scopesOf = async (token: string, verifier: SessionManager) =>
    (
      await new MockTokenVerifier([], [], keyOf(verifier)).verifyAccessToken(
        token
      )
    ).scopes;

  const silenceWarnings = () =>
    vi.spyOn(console, 'warn').mockImplementation(() => {});

  it("lets two processes sharing a store verify each other's tokens", async () => {
    const store = new MemoryRunStore();
    const [a, b] = [manager(store), manager(store)];
    await Promise.all([a.ready(), b.ready()]);
    const key = keyOf(a);
    expect(key).toBeDefined();
    const token = tokenWithScopes('test-token-a', ['mcp:basic'], key);
    expect(await scopesOf(token, b)).toEqual(['mcp:basic']);

    // A process on another store has another key.
    const other = manager(new MemoryRunStore());
    await other.ready();
    expect(await scopesOf(token, other)).toEqual([]);
  });

  it('warns once, without the key, when the store cannot share one', async () => {
    const warn = silenceWarnings();
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

  it('lets requests through within the budget when the store never answers', async () => {
    const warn = silenceWarnings();
    const { app, sessions } = createHostedApp({
      store: new HangingStore(),
      tokenKeyBudgetMs: 200
    });
    managers.push(sessions);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const started = Date.now();
      const res = await fetch(`http://localhost:${port}/scenarios`);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(keyOf(sessions)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        'no answer within 200 ms'
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('retries a failed store call and ends with the shared key', async () => {
    const warn = silenceWarnings();
    const store = new FlakyStore(1);
    const flaky = manager(store);
    await flaky.ready();
    const steady = manager(store);
    await steady.ready();
    expect(keyOf(flaky)).toBeDefined();
    expect(keyOf(flaky)!.equals(keyOf(steady)!)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps its own key once chosen, even if the shared one arrives later', async () => {
    const warn = silenceWarnings();
    const store = new SlowStore(300);
    const late = manager(store, 100);
    await late.ready();
    expect(keyOf(late)).toBeUndefined();
    await sleep(400);
    expect(store.stored).toBeDefined();
    expect(keyOf(late)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(store.stored!);
  });

  it('never prints the key, even when a store error quotes it', async () => {
    const warn = silenceWarnings();
    const store = new LeakyStore();
    await manager(store, 300).ready();
    expect(store.seen).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('insert failed');
    expect(message).not.toContain(store.seen!);
  });
});
