#!/usr/bin/env node

import { Command } from 'commander';
import { ZodError } from 'zod';
import {
  runConformanceTest,
  printClientResults,
  runServerConformanceTest,
  runServerAuthConformanceTest,
  startFakeAuthServer,
  printServerResults,
  printServerSummary,
  runInteractiveMode
} from './runner';
import {
  listScenarios,
  listClientScenarios,
  listActiveClientScenarios,
  listPendingClientScenarios,
  listAuthScenarios,
  listMetadataScenarios,
  listServerAuthScenarios,
  listCoreScenarios,
  listExtensionScenarios,
  listBackcompatScenarios,
  listScenariosForSpec,
  listClientScenariosForSpec,
  getScenarioSpecVersions,
  ALL_SPEC_VERSIONS
} from './scenarios';
import type { SpecVersion } from './scenarios';
import { ConformanceCheck } from './types';
import { ClientOptionsSchema, ServerOptionsSchema } from './schemas';
import {
  loadExpectedFailures,
  evaluateBaseline,
  printBaselineResults
} from './expected-failures';
import { createTierCheckCommand } from './tier-check';
import packageJson from '../package.json';

function resolveSpecVersion(value: string): SpecVersion {
  if (ALL_SPEC_VERSIONS.includes(value as SpecVersion)) {
    return value as SpecVersion;
  }
  console.error(`Unknown spec version: ${value}`);
  console.error(`Valid versions: ${ALL_SPEC_VERSIONS.join(', ')}`);
  process.exit(1);
}

// Note on naming: `command` refers to which CLI command is calling this.
// The `client` command tests Scenario objects (which test clients),
// and the `server` command tests ClientScenario objects (which test servers).
// This matches the inverted naming in scenarios/index.ts.
function filterScenariosBySpecVersion(
  allScenarios: string[],
  version: SpecVersion,
  command: 'client' | 'server'
): string[] {
  const versionScenarios =
    command === 'client'
      ? listScenariosForSpec(version)
      : listClientScenariosForSpec(version);
  const allowed = new Set(versionScenarios);
  return allScenarios.filter((s) => allowed.has(s));
}

const program = new Command();

program
  .name('conformance')
  .description('MCP Conformance Test Suite')
  .version(packageJson.version);

// Client command - tests a client implementation against scenarios
program
  .command('client')
  .description(
    'Run conformance tests against a client implementation or start interactive mode'
  )
  .option('--command <command>', 'Command to run the client')
  .option('--scenario <scenario>', 'Scenario to test')
  .option('--suite <suite>', 'Run a suite of tests in parallel (e.g., "auth")')
  .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
  .option(
    '--expected-failures <path>',
    'Path to YAML file listing expected failures (baseline)'
  )
  .option('-o, --output-dir <path>', 'Save results to this directory')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .option('--verbose', 'Show verbose output')
  .action(async (options) => {
    try {
      const timeout = parseInt(options.timeout, 10);
      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;
      const specVersionFilter = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

      // Handle suite mode
      if (options.suite) {
        if (!options.command) {
          console.error('--command is required when using --suite');
          process.exit(1);
        }

        const suites: Record<string, () => string[]> = {
          all: listScenarios,
          core: listCoreScenarios,
          extensions: listExtensionScenarios,
          backcompat: listBackcompatScenarios,
          auth: listAuthScenarios,
          metadata: listMetadataScenarios,
          'sep-835': () =>
            listAuthScenarios().filter((name) => name.startsWith('auth/scope-'))
        };

        const suiteName = options.suite.toLowerCase();
        if (!suites[suiteName]) {
          console.error(`Unknown suite: ${suiteName}`);
          console.error(`Available suites: ${Object.keys(suites).join(', ')}`);
          process.exit(1);
        }

        let scenarios = suites[suiteName]();
        if (specVersionFilter) {
          scenarios = filterScenariosBySpecVersion(
            scenarios,
            specVersionFilter,
            'client'
          );
        }
        console.log(
          `Running ${suiteName} suite (${scenarios.length} scenarios) in parallel...\n`
        );

        const results = await Promise.all(
          scenarios.map(async (scenarioName) => {
            try {
              const result = await runConformanceTest(
                options.command,
                scenarioName,
                timeout,
                outputDir
              );
              return {
                scenario: scenarioName,
                checks: result.checks,
                error: null
              };
            } catch (error) {
              return {
                scenario: scenarioName,
                checks: [
                  {
                    id: scenarioName,
                    name: scenarioName,
                    description: 'Failed to run scenario',
                    status: 'FAILURE' as const,
                    timestamp: new Date().toISOString(),
                    errorMessage:
                      error instanceof Error ? error.message : String(error)
                  }
                ],
                error
              };
            }
          })
        );

        console.log('\n=== SUITE SUMMARY ===\n');

        let totalPassed = 0;
        let totalFailed = 0;
        let totalWarnings = 0;

        for (const result of results) {
          const passed = result.checks.filter(
            (c) => c.status === 'SUCCESS'
          ).length;
          const failed = result.checks.filter(
            (c) => c.status === 'FAILURE'
          ).length;
          const warnings = result.checks.filter(
            (c) => c.status === 'WARNING'
          ).length;

          totalPassed += passed;
          totalFailed += failed;
          totalWarnings += warnings;

          const status = failed === 0 && warnings === 0 ? '✓' : '✗';
          const warningStr = warnings > 0 ? `, ${warnings} warnings` : '';
          console.log(
            `${status} ${result.scenario}: ${passed} passed, ${failed} failed${warningStr}`
          );

          if (verbose && failed > 0) {
            result.checks
              .filter((c) => c.status === 'FAILURE')
              .forEach((c) => {
                console.log(
                  `    - ${c.name}: ${c.errorMessage || c.description}`
                );
              });
          }
        }

        console.log(
          `\nTotal: ${totalPassed} passed, ${totalFailed} failed, ${totalWarnings} warnings`
        );

        if (options.expectedFailures) {
          const expectedFailuresConfig = await loadExpectedFailures(
            options.expectedFailures
          );
          const baselineScenarios = expectedFailuresConfig.client ?? [];
          const baselineResult = evaluateBaseline(results, baselineScenarios);
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

        process.exit(totalFailed > 0 || totalWarnings > 0 ? 1 : 0);
      }

      // Require either --scenario or --suite
      if (!options.scenario) {
        console.error('Either --scenario or --suite is required');
        console.error('\nAvailable client scenarios:');
        listScenarios().forEach((s) => console.error(`  - ${s}`));
        console.error(
          '\nAvailable suites: all, core, extensions, backcompat, auth, metadata, sep-835'
        );
        process.exit(1);
      }

      // Validate options with Zod for single scenario mode
      const validated = ClientOptionsSchema.parse(options);

      // If no command provided, run in interactive mode
      if (!validated.command) {
        await runInteractiveMode(validated.scenario, verbose, outputDir);
        process.exit(0);
      }

      // Otherwise run conformance test
      const result = await runConformanceTest(
        validated.command,
        validated.scenario,
        timeout,
        outputDir
      );

      const { overallFailure } = printClientResults(
        result.checks,
        verbose,
        result.clientOutput,
        result.allowClientError
      );

      if (options.expectedFailures) {
        const expectedFailuresConfig = await loadExpectedFailures(
          options.expectedFailures
        );
        const baselineScenarios = expectedFailuresConfig.client ?? [];
        const baselineResult = evaluateBaseline(
          [{ scenario: validated.scenario, checks: result.checks }],
          baselineScenarios
        );
        printBaselineResults(baselineResult);
        process.exit(baselineResult.exitCode);
      }

      process.exit(overallFailure ? 1 : 0);
    } catch (error) {
      if (error instanceof ZodError) {
        console.error('Validation error:');
        error.errors.forEach((err) => {
          console.error(`  ${err.path.join('.')}: ${err.message}`);
        });
        console.error('\nAvailable client scenarios:');
        listScenarios().forEach((s) => console.error(`  - ${s}`));
        process.exit(1);
      }
      console.error('Client test error:', error);
      process.exit(1);
    }
  });

// Server command - tests a server implementation
program
  .command('server')
  .description('Run conformance tests against a server implementation')
  .option(
    '--url <url>',
    'URL of the server to test (for already-running servers)'
  )
  .option(
    '--command <cmd>',
    'Command to start the server (for auth suite: spawns fake AS and passes MCP_CONFORMANCE_AUTH_SERVER_URL)'
  )
  .option(
    '--scenario <scenario>',
    'Scenario to test (defaults to active suite if not specified)'
  )
  .option(
    '--suite <suite>',
    'Suite to run: "active" (default, excludes pending), "all", "pending", or "auth"',
    'active'
  )
  .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
  .option(
    '--expected-failures <path>',
    'Path to YAML file listing expected failures (baseline)'
  )
  .option('-o, --output-dir <path>', 'Save results to this directory')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .option(
    '--interactive',
    'Interactive auth mode: opens browser for login instead of auto-redirect'
  )
  .option(
    '--client-id <id>',
    'Pre-registered OAuth client ID (skips CIMD/DCR registration)'
  )
  .option(
    '--client-secret <secret>',
    'Pre-registered OAuth client secret (used with --client-id)'
  )
  .action(async (options) => {
    try {
      const verbose = options.verbose ?? false;
      const timeout = parseInt(options.timeout, 10);
      const outputDir = options.outputDir;
      const suite = options.suite?.toLowerCase() || 'active';
      const specVersionFilter = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;
      const isAuthTest =
        suite === 'auth' || options.scenario?.startsWith('server-auth/');

      // Input validation
      if (isAuthTest) {
        if (!options.url && !options.command) {
          console.error(
            'For auth testing, either --url or --command is required'
          );
          console.error('\n--url <url>     URL of already running server');
          console.error(
            '--command <cmd> Command to start the server (conformance spawns fake AS)'
          );
          process.exit(1);
        }
      } else {
        if (!options.url) {
          console.error('--url is required for non-auth server testing');
          process.exit(1);
        }
      }

      // Single-scenario fast path (detailed per-check output)
      if (options.scenario) {
        let checks: ConformanceCheck[];
        let scenarioDescription: string;

        if (isAuthTest) {
          const result = await runServerAuthConformanceTest({
            url: options.url,
            command: options.command,
            scenarioName: options.scenario,
            timeout,
            interactive: options.interactive,
            clientId: options.clientId,
            clientSecret: options.clientSecret
          });
          checks = result.checks;
          scenarioDescription = result.scenarioDescription;
        } else {
          const validated = ServerOptionsSchema.parse(options);
          const result = await runServerConformanceTest(
            validated.url,
            validated.scenario!,
            outputDir
          );
          checks = result.checks;
          scenarioDescription = result.scenarioDescription;
        }

        const { failed } = printServerResults(
          checks,
          scenarioDescription,
          verbose
        );

        if (options.expectedFailures) {
          const expectedFailuresConfig = await loadExpectedFailures(
            options.expectedFailures
          );
          const baselineScenarios = expectedFailuresConfig.server ?? [];
          const baselineResult = evaluateBaseline(
            [{ scenario: options.scenario, checks }],
            baselineScenarios
          );
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

        process.exit(failed > 0 ? 1 : 0);
      }

      // Suite resolution
      let scenarios: string[];
      if (isAuthTest) {
        scenarios = listServerAuthScenarios();
      } else {
        if (suite === 'all') {
          scenarios = listClientScenarios();
        } else if (suite === 'active' || suite === 'core') {
          scenarios = listActiveClientScenarios();
        } else if (suite === 'pending') {
          scenarios = listPendingClientScenarios();
        } else {
          console.error(`Unknown suite: ${suite}`);
          console.error('Available suites: active, all, core, pending, auth');
          process.exit(1);
        }
        if (specVersionFilter) {
          scenarios = filterScenariosBySpecVersion(
            scenarios,
            specVersionFilter,
            'server'
          );
        }
      }

      console.log(
        `Running ${suite} suite (${scenarios.length} scenarios)${options.url ? ` against ${options.url}` : ''}...\n`
      );

      // Run loop
      const allResults: { scenario: string; checks: ConformanceCheck[] }[] = [];

      for (const scenarioName of scenarios) {
        console.log(`\n=== Running scenario: ${scenarioName} ===`);
        try {
          let checks: ConformanceCheck[];
          let scenarioDescription: string;
          if (isAuthTest) {
            const result = await runServerAuthConformanceTest({
              url: options.url,
              command: options.command,
              scenarioName,
              timeout,
              interactive: options.interactive,
              clientId: options.clientId,
              clientSecret: options.clientSecret
            });
            checks = result.checks;
            scenarioDescription = result.scenarioDescription;
          } else {
            const result = await runServerConformanceTest(
              options.url,
              scenarioName,
              outputDir
            );
            checks = result.checks;
            scenarioDescription = result.scenarioDescription;
          }
          allResults.push({ scenario: scenarioName, checks });
          if (verbose) {
            printServerResults(checks, scenarioDescription, verbose);
          }
        } catch (error) {
          console.error(`Failed to run scenario ${scenarioName}:`, error);
          allResults.push({
            scenario: scenarioName,
            checks: [
              {
                id: scenarioName,
                name: scenarioName,
                description: 'Failed to run scenario',
                status: 'FAILURE',
                timestamp: new Date().toISOString(),
                errorMessage:
                  error instanceof Error ? error.message : String(error)
              }
            ]
          });
        }
      }

      // Summary + baseline
      const { totalFailed } = printServerSummary(allResults);

      if (options.expectedFailures) {
        const expectedFailuresConfig = await loadExpectedFailures(
          options.expectedFailures
        );
        const baselineScenarios = expectedFailuresConfig.server ?? [];
        const baselineResult = evaluateBaseline(allResults, baselineScenarios);
        printBaselineResults(baselineResult);
        process.exit(baselineResult.exitCode);
      }

      process.exit(totalFailed > 0 ? 1 : 0);
    } catch (error) {
      if (error instanceof ZodError) {
        console.error('Validation error:');
        error.errors.forEach((err) => {
          console.error(`  ${err.path.join('.')}: ${err.message}`);
        });
        console.error('\nAvailable server scenarios:');
        listClientScenarios().forEach((s) => console.error(`  - ${s}`));
        console.error('\nAvailable server auth scenarios:');
        listServerAuthScenarios().forEach((s) => console.error(`  - ${s}`));
        process.exit(1);
      }
      console.error('Server test error:', error);
      process.exit(1);
    }
  });

// Tier check command
program.addCommand(createTierCheckCommand());

// List scenarios command
program
  .command('list')
  .description('List available test scenarios')
  .option('--client', 'List client scenarios')
  .option('--server', 'List server scenarios')
  .option('--server-auth', 'List server auth scenarios')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .action((options) => {
    const showAll = !options.client && !options.server && !options.serverAuth;
    const specVersionFilter = options.specVersion
      ? resolveSpecVersion(options.specVersion)
      : undefined;

    if (options.server || showAll) {
      console.log('Server scenarios (test against a server):');
      let serverScenarios = listClientScenarios();
      if (specVersionFilter) {
        serverScenarios = filterScenariosBySpecVersion(
          serverScenarios,
          specVersionFilter,
          'server'
        );
      }
      serverScenarios.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }

    if (options.serverAuth || showAll) {
      if (options.server || showAll) {
        console.log('');
      }
      console.log('Server auth scenarios (test server auth implementation):');
      const authScenarios = listServerAuthScenarios();
      authScenarios.forEach((s) => console.log(`  - ${s}`));
    }

    if (options.client || showAll) {
      if (options.server || options.serverAuth || showAll) {
        console.log('');
      }
      console.log('Client scenarios (test against a client):');
      let clientScenarioNames = listScenarios();
      if (specVersionFilter) {
        clientScenarioNames = filterScenariosBySpecVersion(
          clientScenarioNames,
          specVersionFilter,
          'client'
        );
      }
      clientScenarioNames.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }
  });

// Fake auth server command - starts a standalone fake authorization server
program
  .command('fake-auth-server')
  .description(
    'Start a standalone fake authorization server for manual testing'
  )
  .option('--port <port>', 'Port to listen on (default: random)')
  .action(async (options) => {
    const port = options.port ? parseInt(options.port, 10) : undefined;

    console.log('Starting fake authorization server...');
    const { url, stop } = await startFakeAuthServer(port);
    console.log(`\nFake authorization server running at: ${url}`);
    console.log('\nEndpoints:');
    console.log(
      `  Metadata:      ${url}/.well-known/oauth-authorization-server`
    );
    console.log(`  Authorization: ${url}/authorize`);
    console.log(`  Token:         ${url}/token`);
    console.log(`  Registration:  ${url}/register`);
    console.log('\nPress Ctrl+C to stop.');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down...');
      await stop();
      process.exit(0);
    });

    // Keep the process running
    await new Promise(() => {});
  });

program.parse();
