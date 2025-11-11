#!/usr/bin/env node

import { Command } from 'commander';
import { ZodError } from 'zod';
import {
  runConformanceTest,
  printClientResults,
  runServerConformanceTest,
  printServerResults,
  printServerSummary
} from './runner';
import { listScenarios, listClientScenarios } from './scenarios';
import { ConformanceCheck } from './types';
import { ClientOptionsSchema, ServerOptionsSchema } from './schemas';

const program = new Command();

program
  .name('conformance')
  .description('MCP Conformance Test Suite')
  .version('0.1.0');

// Client command - tests a client implementation against scenarios
program
  .command('client')
  .description('Run conformance tests against a client implementation')
  .requiredOption('--command <command>', 'Command to run the client')
  .requiredOption('--scenario <scenario>', 'Scenario to test')
  .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
  .option('--verbose', 'Show verbose output')
  .action(async (options) => {
    try {
      // Validate options with Zod
      const validated = ClientOptionsSchema.parse(options);

      const result = await runConformanceTest(
        validated.command,
        validated.scenario,
        validated.timeout
      );

      const { failed } = printClientResults(
        result.checks,
        validated.verbose ?? false
      );
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
    '--scenario <scenarios...>',
    'Scenario(s) to test (defaults to all scenarios if not specified)'
  )
  .action(async (options) => {
    try {
      // Validate options with Zod
      const validated = ServerOptionsSchema.parse(options);

      // Determine which scenarios to run
      const scenariosToRun = validated.scenario || listClientScenarios();

      // Run multiple scenarios
      if (scenariosToRun.length > 1) {
        console.log(
          `Running ${scenariosToRun.length} scenarios against ${validated.url}\n`
        );

        const allResults: { scenario: string; checks: ConformanceCheck[] }[] =
          [];

        for (const scenarioName of scenariosToRun) {
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
      } else {
        // Run single scenario
        const result = await runServerConformanceTest(
          validated.url,
          scenariosToRun[0]
        );

        const { failed } = printServerResults(result.checks);
        process.exit(failed > 0 ? 1 : 0);
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
