import { describe, it, expect } from 'vitest';
import type { Server } from 'http';
import { createHostedApp, type HostedServerOptions } from './server';
import { duration } from './html';
import { DEFAULT_CELL_TTL_MS } from './session';
import { MemoryRunStore } from './store';

/** GET / from a fresh app, as text with tags dropped. */
async function landing(opts: HostedServerOptions = {}): Promise<string> {
  const { app, sessions } = createHostedApp(opts);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const html = await fetch(`http://localhost:${port}/`).then((r) => r.text());
    return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  } finally {
    await sessions.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('GET / states this deployment’s lifetimes', () => {
  it('a single process: in memory, at the default idle TTL', async () => {
    const said = await landing();
    expect(said).toContain(
      `dropped once the cell has had no request for ${duration(DEFAULT_CELL_TTL_MS)}`
    );
    expect(said).toContain('frozen copies last until the server restarts');
  });

  it('the idle TTL it was started with (the CLI’s --ttl)', async () => {
    expect(await landing({ ttlMs: 120_000 })).toContain(
      'no request for 2 minutes'
    );
  });

  it('a store’s own lifetimes, when it states them', async () => {
    const store = Object.assign(new MemoryRunStore(), {
      retention: { runMs: 3 * 3600_000, snapshotMs: 14 * 24 * 3600_000 }
    });
    const said = await landing({ store });
    expect(said).toContain('kept for 3 hours from your client’s first request');
    expect(said).toContain('A frozen copy is kept for 14 days');
    expect(said).toContain(
      `A cell with no request for ${duration(DEFAULT_CELL_TTL_MS)} leaves memory`
    );
    expect(said).not.toContain('in memory only');
  });

  it('names the server build in the footer', async () => {
    expect(
      await landing({
        build: { build: '9004a11', deployedAt: '2026-09-14T06:40:00.000Z' }
      })
    ).toContain('Server build 9004a11, deployed 2026-09-14 06:40 UTC.');
    // Not stamped (a repository checkout's server.ts, not the CLI).
    expect(await landing()).toContain('Server build unknown.');
  });

  it('a store that states none: no numbers invented', async () => {
    const said = await landing({ store: new MemoryRunStore() });
    expect(said).toContain('for as long as it is set to keep it');
    expect(said).not.toMatch(/kept for \d/);
  });
});
