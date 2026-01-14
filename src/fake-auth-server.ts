#!/usr/bin/env node

import { Command } from 'commander';
import { createAuthServer } from './scenarios/client/auth/helpers/createAuthServer';
import { ServerLifecycle } from './scenarios/client/auth/helpers/serverLifecycle';
import type { ConformanceCheck } from './types';

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

    // If a specific port is requested, we need to handle URL differently
    if (port !== 0) {
      // For fixed port, we need to track the URL ourselves since we're not using lifecycle.start()
      let serverUrl = '';
      const getUrl = () => serverUrl;

      const app = createAuthServer(checks, getUrl, {
        loggingEnabled: true
      });

      const httpServer = app.listen(port, () => {
        const address = httpServer.address();
        const actualPort =
          typeof address === 'object' && address ? address.port : port;
        serverUrl = `http://localhost:${actualPort}`;
        console.log(`Fake Auth Server running at ${serverUrl}`);
        console.log('');
        console.log('Endpoints:');
        console.log(
          `  Metadata:      ${serverUrl}/.well-known/oauth-authorization-server`
        );
        console.log(`  Authorization: ${serverUrl}/authorize`);
        console.log(`  Token:         ${serverUrl}/token`);
        console.log(`  Registration:  ${serverUrl}/register`);
        console.log('');
        console.log('Press Ctrl+C to stop');
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nShutting down...');
        httpServer.close(() => {
          process.exit(0);
        });
      });
    } else {
      // Use ServerLifecycle for random port assignment
      const lifecycle = new ServerLifecycle();

      const app = createAuthServer(checks, lifecycle.getUrl, {
        loggingEnabled: true
      });

      const url = await lifecycle.start(app);
      console.log(`Fake Auth Server running at ${url}`);
      console.log('');
      console.log('Endpoints:');
      console.log(
        `  Metadata:      ${url}/.well-known/oauth-authorization-server`
      );
      console.log(`  Authorization: ${url}/authorize`);
      console.log(`  Token:         ${url}/token`);
      console.log(`  Registration:  ${url}/register`);
      console.log('');
      console.log('Press Ctrl+C to stop');

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await lifecycle.stop();
        process.exit(0);
      });
    }
  });

program.parse();
