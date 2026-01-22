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
  listCoreScenarios,
  listExtensionScenarios
} from './scenarios';
import { ConformanceCheck } from './types';
import { ClientOptionsSchema, ServerOptionsSchema } from './schemas';
import {
  loadExpectedFailures,
  evaluateBaseline,
  printBaselineResults
} from './expected-failures';
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
  .option(
    '--expected-failures <path>',
    'Path to YAML file listing expected failures (baseline)'
  )
  .option('-o, --output-dir <path>', 'Save results to this directory')
  .option('--verbose', 'Show verbose output')
  .action(async (options) => {
    try {
      const timeout = parseInt(options.timeout, 10);
      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;

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
          '\nAvailable suites: all, core, extensions, auth, metadata, sep-835'
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
        result.clientOutput
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
  .requiredOption('--url <url>', 'URL of the server to test')
  .option(
    '--scenario <scenario>',
    'Scenario to test (defaults to active suite if not specified)'
  )
  .option(
    '--suite <suite>',
    'Suite to run: "active" (default, excludes pending), "all", or "pending"',
    'active'
  )
  .option(
    '--expected-failures <path>',
    'Path to YAML file listing expected failures (baseline)'
  )
  .option('-o, --output-dir <path>', 'Save results to this directory')
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .action(async (options) => {
    try {
      // Validate options with Zod
      const validated = ServerOptionsSchema.parse(options);

      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;

      // If a single scenario is specified, run just that one
      if (validated.scenario) {
        const result = await runServerConformanceTest(
          validated.url,
          validated.scenario,
          outputDir
        );

        const { failed } = printServerResults(
          result.checks,
          result.scenarioDescription,
          verbose
        );

        if (options.expectedFailures) {
          const expectedFailuresConfig = await loadExpectedFailures(
            options.expectedFailures
          );
          const baselineScenarios = expectedFailuresConfig.server ?? [];
          const baselineResult = evaluateBaseline(
            [{ scenario: validated.scenario!, checks: result.checks }],
            baselineScenarios
          );
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

        process.exit(failed > 0 ? 1 : 0);
      } else {
        // Run scenarios based on suite
        const suite = options.suite?.toLowerCase() || 'active';
        let scenarios: string[];

        if (suite === 'all') {
          scenarios = listClientScenarios();
        } else if (suite === 'active' || suite === 'core') {
          // 'core' is an alias for 'active' - tier 1 requirements
          scenarios = listActiveClientScenarios();
        } else if (suite === 'pending') {
          scenarios = listPendingClientScenarios();
        } else {
          console.error(`Unknown suite: ${suite}`);
          console.error('Available suites: active, all, core, pending');
          process.exit(1);
        }

        console.log(
          `Running ${suite} suite (${scenarios.length} scenarios) against ${validated.url}\n`
        );

        const allResults: { scenario: string; checks: ConformanceCheck[] }[] =
          [];

        for (const scenarioName of scenarios) {
          console.log(`\n=== Running scenario: ${scenarioName} ===`);
          try {
            const result = await runServerConformanceTest(
              validated.url,
              scenarioName,
              outputDir
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

        if (options.expectedFailures) {
          const expectedFailuresConfig = await loadExpectedFailures(
            options.expectedFailures
          );
          const baselineScenarios = expectedFailuresConfig.server ?? [];
          const baselineResult = evaluateBaseline(
            allResults,
            baselineScenarios
          );
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

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
  .action((options) => {
    if (options.server || (!options.client && !options.server)) {
      console.log('Server scenarios (test against a server):');
      const serverScenarios = listClientScenarios();
      serverScenarios.forEach((s) => console.log(`  - ${s}`));
    }

    if (options.client || (!options.client && !options.server)) {
      if (options.server || (!options.client && !options.server)) {
        console.log('');
      }
      console.log('Client scenarios (test against a client):');
      const clientScenarios = listScenarios();
      clientScenarios.forEach((s) => console.log(`  - ${s}`));
    }
  });

program.parse();
