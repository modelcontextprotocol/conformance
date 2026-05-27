import { createHostedApp } from './server';
import { listHostableScenarios } from './session';

export { createHostedApp } from './server';
export { listHostableScenarios } from './session';

export interface HostedCliOptions {
  port: number;
  publicOrigin?: string;
  ttlMs?: number;
}

export async function runHostedServer(opts: HostedCliOptions): Promise<void> {
  const { app, sessions } = createHostedApp({
    publicOrigin: opts.publicOrigin,
    ttlMs: opts.ttlMs
  });

  const server = app.listen(opts.port, () => {
    const origin = opts.publicOrigin ?? `http://localhost:${opts.port}`;
    console.error(`MCP conformance hosted server listening on ${origin}`);
    console.error(
      `  ${listHostableScenarios().length} scenarios mounted under ${origin}/s/<name>`
    );
    console.error(`  meta MCP server at ${origin}/mcp`);
  });

  const shutdown = async () => {
    console.error('\nshutting down...');
    await sessions.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}
