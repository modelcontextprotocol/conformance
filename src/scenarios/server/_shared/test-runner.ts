/**
 * Test-runner utilities for server-conformance scenarios.
 *
 * Used by `*.test.ts` runner files that auto-spawn a fixture binary
 * before running scenarios. These helpers are language-agnostic and
 * harness-only — they don't touch MCP protocol, so they don't belong
 * in the SDK.
 *
 * Single responsibility today: TCP readiness polling. Spawn / cleanup
 * scaffolding stays inline in each runner so the file reads top-to-bottom
 * without indirection (per AGENTS.md "repetitive check blocks are fine").
 */

import { connect } from 'net';

/**
 * Poll the host/port of the given URL until a TCP connection succeeds
 * or the timeout elapses. Language-agnostic readiness check — works
 * for any server that binds before serving requests.
 */
export async function waitForServerReady(
  url: string,
  timeoutMs: number
): Promise<void> {
  const u = new URL(url);
  const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
  const host = u.hostname;
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.once('error', (err) => {
          socket.destroy();
          reject(err);
        });
        socket.setTimeout(1_000, () => {
          socket.destroy();
          reject(new Error('connect timeout'));
        });
      });
      return;
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(
    `${host}:${port} did not accept TCP connections (last: ${lastErr?.message ?? 'unknown'})`
  );
}
