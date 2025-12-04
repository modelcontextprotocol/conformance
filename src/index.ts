#!/usr/bin/env node

import { Command } from 'commander';
import { ZodError } from 'zod';
import {
  runConformanceTest,
  printClientResults,
  runServerConformanceTest,
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
  listServerAuthScenarios
} from './scenarios';
import { ConformanceCheck } from './types';
import { ClientOptionsSchema, ServerOptionsSchema } from './schemas';
import packageJson from '../package.json';

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
  .option('--verbose', 'Show verbose output')
  .action(async (options) => {
    try {
      const timeout = parseInt(options.timeout, 10);
      const verbose = options.verbose ?? false;

      // Handle suite mode
      if (options.suite) {
        if (!options.command) {
          console.error('--command is required when using --suite');
          process.exit(1);
        }

        const suites: Record<string, () => string[]> = {
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

        const scenarios = suites[suiteName]();
        console.log(
          `Running ${suiteName} suite (${scenarios.length} scenarios) in parallel...\n`
        );

        const results = await Promise.all(
          scenarios.map(async (scenarioName) => {
            try {
              const result = await runConformanceTest(
                options.command,
                scenarioName,
                timeout
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

          const status = failed === 0 ? '✓' : '✗';
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
        process.exit(totalFailed > 0 ? 1 : 0);
      }

      // Require either --scenario or --suite
      if (!options.scenario) {
        console.error('Either --scenario or --suite is required');
        console.error('\nAvailable client scenarios:');
        listScenarios().forEach((s) => console.error(`  - ${s}`));
        console.error('\nAvailable suites: auth, metadata, sep-835');
        process.exit(1);
      }

      // Validate options with Zod for single scenario mode
      const validated = ClientOptionsSchema.parse(options);

      // If no command provided, run in interactive mode
      if (!validated.command) {
        await runInteractiveMode(validated.scenario, verbose);
        process.exit(0);
      }

      // Otherwise run conformance test
      const result = await runConformanceTest(
        validated.command,
        validated.scenario,
        timeout
      );

      const { failed } = printClientResults(result.checks, verbose);
      process.exit(failed > 0 ? 1 : 0);
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
  .requiredOption('--url <url>', 'URL of the server to test')
  .option(
    '--scenario <scenario>',
    'Scenario to test (defaults to active suite if not specified)'
  )
  .option(
    '--suite <suite>',
    'Suite to run: "active" (default), "all", "pending", or "auth"',
    'active'
  )
  .option('--auth', 'Include OAuth conformance tests (server/auth-* scenarios)')
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .action(async (options) => {
    try {
      // Validate options with Zod
      const validated = ServerOptionsSchema.parse(options);

      const verbose = options.verbose ?? false;

      // If a single scenario is specified, run just that one
      if (validated.scenario) {
        const result = await runServerConformanceTest(
          validated.url,
          validated.scenario
        );

        const { failed } = printServerResults(
          result.checks,
          result.scenarioDescription,
          verbose
        );
        process.exit(failed > 0 ? 1 : 0);
      } else {
        // Run scenarios based on suite
        const suite = options.suite?.toLowerCase() || 'active';
        const includeAuth = options.auth ?? false;
        let scenarios: string[];

        if (suite === 'all') {
          scenarios = listClientScenarios();
        } else if (suite === 'active') {
          scenarios = listActiveClientScenarios();
          // Add auth scenarios if --auth flag is set
          if (includeAuth) {
            scenarios = [...scenarios, ...listServerAuthScenarios()];
          }
        } else if (suite === 'pending') {
          scenarios = listPendingClientScenarios();
        } else if (suite === 'auth') {
          // Run only auth scenarios
          scenarios = listServerAuthScenarios();
        } else {
          console.error(`Unknown suite: ${suite}`);
          console.error('Available suites: active, all, pending, auth');
          process.exit(1);
        }

        const authNote = includeAuth && suite !== 'auth' ? ' (with auth)' : '';
        console.log(
          `Running ${suite}${authNote} suite (${scenarios.length} scenarios) against ${validated.url}\n`
        );

        const allResults: { scenario: string; checks: ConformanceCheck[] }[] =
          [];

        for (const scenarioName of scenarios) {
          console.log(`\n=== Running scenario: ${scenarioName} ===`);
          try {
            const result = await runServerConformanceTest(
              validated.url,
              scenarioName
            );
            allResults.push({ scenario: scenarioName, checks: result.checks });
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

        const { totalFailed } = printServerSummary(allResults);
        process.exit(totalFailed > 0 ? 1 : 0);
      }
    } catch (error) {
      if (error instanceof ZodError) {
        console.error('Validation error:');
        error.errors.forEach((err) => {
          console.error(`  ${err.path.join('.')}: ${err.message}`);
        });
        console.error('\nAvailable server scenarios:');
        listClientScenarios().forEach((s) => console.error(`  - ${s}`));
        process.exit(1);
      }
      console.error('Server test error:', error);
      process.exit(1);
    }
  });

// List scenarios command
program
  .command('list')
  .description('List available test scenarios')
  .option('--client', 'List client scenarios')
  .option('--server', 'List server scenarios')
  .option('--auth', 'List server OAuth auth scenarios')
  .action((options) => {
    const showAll = !options.client && !options.server && !options.auth;

    if (options.server || showAll) {
      console.log('Server scenarios (test against a server):');
      const serverScenarios = listClientScenarios();
      serverScenarios.forEach((s) => console.log(`  - ${s}`));
    }

    if (options.auth || showAll) {
      if (options.server || showAll) {
        console.log('');
      }
      console.log('Server OAuth scenarios (use --auth or --suite auth):');
      const authScenarios = listServerAuthScenarios();
      authScenarios.forEach((s) => console.log(`  - ${s}`));
    }

    if (options.client || showAll) {
      if (options.server || options.auth || showAll) {
        console.log('');
      }
      console.log('Client scenarios (test against a client):');
      const clientScenarios = listScenarios();
      clientScenarios.forEach((s) => console.log(`  - ${s}`));
    }
  });

program.parse();
