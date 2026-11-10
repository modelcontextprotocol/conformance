import { createHostedApp } from './server';
import { AuxOriginRole } from '../types';

export { createHostedApp } from './server';
export { buildMatrix } from './matrix';

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

  const { app, sessions, matrix } = createHostedApp({
    publicOrigin: opts.publicOrigin,
    ttlMs: opts.ttlMs,
    auxOrigins,
    relaySecret: opts.relaySecret
  });

  const server = app.listen(opts.port, () => {
    const origin = opts.publicOrigin ?? `http://localhost:${opts.port}`;
    const startable = matrix.cells().filter((c) => c.startable).length;
    console.error(`MCP conformance hosted server listening on ${origin}`);
    console.error(
      `  ${matrix.rows.length} scenarios × ${matrix.revisions.length} revisions ` +
        `(${matrix.revisions.join(', ')}); ${startable} startable cells under ` +
        `${origin}/s/<run-id>/<revision>/<scenario>`
    );
    console.error(`  GET ${origin}/s mints a run id`);
    if (haveAux.length) {
      for (const r of haveAux) {
        console.error(`  aux[${r}] relay origin: ${auxOrigins[r]}`);
      }
    } else {
      console.error(
        '  (auth/* cells not startable — pass --as-origin to enable them)'
      );
    }
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
