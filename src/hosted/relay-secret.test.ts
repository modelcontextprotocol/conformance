import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHostedApp } from './server';

/**
 * A relay secret too short to key the token MAC makes scope checks fail
 * across processes. The server must say so at startup, without printing
 * the secret or anything about it beyond "too short".
 */
describe('the relay secret warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const warningsAtStartup = (opts: Parameters<typeof createHostedApp>[0]) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sessions } = createHostedApp(opts);
    void sessions.close();
    return warn.mock.calls.map((args) => args.join(' '));
  };

  it('is printed once for a short secret, without the secret', () => {
    const secret = 'short-relay-secret';
    const warnings = warningsAtStartup({
      auxOrigins: { as: 'https://as.example' },
      relaySecret: secret
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('shorter than 32 characters');
    expect(warnings[0]).toContain('openssl rand -hex 32');
    expect(warnings[0]).not.toContain(secret);
    expect(warnings[0]).not.toContain(String(secret.length));
  });

  it('is not printed for a long secret, or without a relay origin', () => {
    expect(
      warningsAtStartup({
        auxOrigins: { as: 'https://as.example' },
        relaySecret: 'x'.repeat(64)
      })
    ).toEqual([]);
    expect(warningsAtStartup({ relaySecret: 'short' })).toEqual([]);
  });
});
