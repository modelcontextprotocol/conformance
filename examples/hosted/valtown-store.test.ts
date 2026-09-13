import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHostedApp } from '../../src/hosted/server';
import { duration } from '../../src/hosted/html';
import { DEFAULT_CELL_TTL_MS } from '../../src/hosted/session';
import { toFetchHandler } from './fetch-bridge';
import {
  DEFAULT_RUN_RETENTION_MS,
  DEFAULT_SNAPSHOT_RETENTION_MS,
  SqliteRunStore
} from './valtown-store';

const ENV = [
  'CONFORMANCE_RUN_RETENTION_MS',
  'CONFORMANCE_SNAPSHOT_RETENTION_MS'
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('val.town store retention, as the landing page states it', () => {
  it('defaults to its named constants', () => {
    for (const k of ENV) delete process.env[k];
    expect(new SqliteRunStore({ token: 't' }).retention).toEqual({
      runMs: DEFAULT_RUN_RETENTION_MS,
      snapshotMs: DEFAULT_SNAPSHOT_RETENTION_MS
    });
    // What the page and the README say today.
    expect(duration(DEFAULT_RUN_RETENTION_MS)).toBe('6 hours');
    expect(duration(DEFAULT_SNAPSHOT_RETENTION_MS)).toBe('30 days');
  });

  it('reports the values in force, env overrides included', () => {
    process.env.CONFORMANCE_RUN_RETENTION_MS = String(12 * 3600_000);
    expect(new SqliteRunStore({ token: 't' }).retention.runMs).toBe(
      12 * 3600_000
    );
  });

  it('the deployed landing page states the store’s lifetimes and the idle TTL', async () => {
    for (const k of ENV) delete process.env[k];
    const { app, sessions } = createHostedApp({
      store: new SqliteRunStore({ token: 't' })
    });
    try {
      const html = await toFetchHandler(app)(new Request('http://test/')).then(
        (r) => r.text()
      );
      const said = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
      expect(said).toContain(
        `kept for ${duration(DEFAULT_RUN_RETENTION_MS)} from your client’s first request`
      );
      expect(said).toContain(
        `A frozen copy is kept for ${duration(DEFAULT_SNAPSHOT_RETENTION_MS)}`
      );
      expect(said).toContain(
        `A cell with no request for ${duration(DEFAULT_CELL_TTL_MS)} leaves memory`
      );
    } finally {
      await sessions.close();
    }
  });

  it('the hosted README gives the same numbers', () => {
    const readme = readFileSync(
      join(__dirname, '../../src/hosted/README.md'),
      'utf8'
    ).replace(/\s+/g, ' ');
    for (const ms of [
      DEFAULT_RUN_RETENTION_MS,
      DEFAULT_SNAPSHOT_RETENTION_MS,
      DEFAULT_CELL_TTL_MS
    ]) {
      expect(readme).toContain(duration(ms));
    }
  });
});
