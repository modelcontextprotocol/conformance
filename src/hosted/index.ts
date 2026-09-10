import { createHostedApp } from './server';
import { listHostableScenarios } from './session';
import { AuxOriginRole } from '../types';

export { createHostedApp } from './server';
export { listHostableScenarios } from './session';

export interface HostedCliOptions {
  port: number;
  publicOrigin?: string;
  ttlMs?: number;
  auxOrigins?: Partial<Record<AuxOriginRole, string>>;
  relaySecret?: string;
}

export async function runHostedServer(opts: HostedCliOptions): Promise<void> {
  const auxOrigins = opts.auxOrigins ?? {};
  const haveAux = (Object.keys(auxOrigins) as AuxOriginRole[]).filter(
    (r) => auxOrigins[r]
  );
  if (haveAux.length && !opts.relaySecret) {
    console.error(
      'Refusing to start with --as-origin but no --relay-secret: the /__aux ' +
        'backchannel would be open to direct check-forgery. Set ' +
        '--relay-secret (or CONFORMANCE_RELAY_SECRET) to the same value the ' +
        'relay sends.'
    );
    process.exit(1);
  }

  const { app, sessions } = createHostedApp({
    publicOrigin: opts.publicOrigin,
    ttlMs: opts.ttlMs,
    auxOrigins,
    relaySecret: opts.relaySecret
  });

  const server = app.listen(opts.port, () => {
    const origin = opts.publicOrigin ?? `http://localhost:${opts.port}`;
    console.error(`MCP conformance hosted server listening on ${origin}`);
    console.error(
      `  ${listHostableScenarios(haveAux).length} scenarios mounted under ${origin}/s/<name>`
    );
    if (haveAux.length) {
      for (const r of haveAux) {
        console.error(`  aux[${r}] relay origin: ${auxOrigins[r]}`);
      }
    } else {
      console.error(
        '  (auth/* scenarios disabled — pass --as-origin to enable)'
      );
    }
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
