#!/usr/bin/env node

import { Command } from 'commander';
import { createAuthServer } from './scenarios/client/auth/helpers/createAuthServer';
import { ServerLifecycle } from './scenarios/client/auth/helpers/serverLifecycle';
import type { ConformanceCheck } from './types';

function printServerInfo(url: string): void {
  console.log(`Fake Auth Server running at ${url}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  Metadata:      ${url}/.well-known/oauth-authorization-server`);
  console.log(`  Authorization: ${url}/authorize`);
  console.log(`  Token:         ${url}/token`);
  console.log(`  Registration:  ${url}/register`);
  console.log(`  Introspection: ${url}/introspect`);
  console.log('');
  console.log('Press Ctrl+C to stop');
}

const program = new Command();

program
  .name('fake-auth-server')
  .description(
    'Standalone fake OAuth authorization server for testing MCP clients'
  )
  .option('--port <port>', 'Port to listen on (0 for random)', '0')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const checks: ConformanceCheck[] = [];
    const lifecycle = new ServerLifecycle();

    const app = createAuthServer(checks, lifecycle.getUrl, {
      loggingEnabled: true
    });

    const url = await lifecycle.start(app, port !== 0 ? port : undefined);
    printServerInfo(url);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await lifecycle.stop();
      process.exit(0);
    });
  });

program.parse();
