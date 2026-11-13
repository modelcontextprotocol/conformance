import { describe, expect, it } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { withManagedServer } from './index';

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port)
    );
  });
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

function serverCommand(port: number): string {
  const js = `require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(js)}`;
}

describe('withManagedServer', () => {
  it('refuses to start when something already answers on the url', async () => {
    const stranger = http.createServer((_, res) => res.end('not the sdk'));
    const port = await listen(stranger);
    let ran = false;
    try {
      await expect(
        withManagedServer(
          serverCommand(port),
          process.cwd(),
          `http://127.0.0.1:${port}/mcp`,
          5000,
          async () => {
            ran = true;
          }
        )
      ).rejects.toThrow(/already in use .*something answered/);
      expect(ran).toBe(false);
    } finally {
      await new Promise((r) => stranger.close(r));
    }
  });

  it('refuses when a leftover accepts the connection but never answers', async () => {
    const sockets = new Set<net.Socket>();
    const staller = net.createServer((s) => sockets.add(s));
    const port = await new Promise<number>((resolve) =>
      staller.listen(0, '127.0.0.1', () =>
        resolve((staller.address() as AddressInfo).port)
      )
    );
    let ran = false;
    try {
      await expect(
        withManagedServer(
          serverCommand(port),
          process.cwd(),
          `http://127.0.0.1:${port}/mcp`,
          5000,
          async () => {
            ran = true;
          }
        )
      ).rejects.toThrow(/already in use .*did not answer within/);
      expect(ran).toBe(false);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => staller.close(r));
    }
  });

  it('runs against the server it started when the port is free', async () => {
    const port = await freePort();
    const result = await withManagedServer(
      serverCommand(port),
      process.cwd(),
      `http://127.0.0.1:${port}/mcp`,
      10000,
      async () => 'graded'
    );
    expect(result).toBe('graded');
  }, 20000);
});
