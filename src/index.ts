#!/usr/bin/env node

import { Command, Option } from 'commander';
import { ZodError } from 'zod';
import { promises as fs } from 'fs';
import {
  runConformanceTest,
  printClientResults,
  runServerConformanceTest,
  printServerResults,
  printServerSummary,
  runInteractiveMode
} from './runner';
import {
  printAuthorizationServerResults,
  printAuthorizationServerSummary,
  runAuthorizationServerConformanceTest
} from './runner/authorization-server';
import {
  listScenarios,
  listClientScenarios,
  listActiveClientScenarios,
  listPendingClientScenarios,
  listAuthScenarios,
  listMetadataScenarios,
  listCoreScenarios,
  listExtensionScenarios,
  listBackcompatScenarios,
  listDraftScenarios,
  listDraftClientScenarios,
  listScenariosForSpec,
  listClientScenariosForSpec,
  getScenarioSpecVersions,
  listClientScenariosForAuthorizationServer,
  listClientScenariosForAuthorizationServerForSpec,
  resolveSpecVersion,
  resolveExtensionIds,
  filterScenariosByExtensions,
  getScenarioExtensionId
} from './scenarios';
import type { SpecVersion } from './scenarios';
import type { ExtensionSelection } from './scenarios';
import { ConformanceCheck } from './types';
import {
  AuthorizationServerOptionsSchema,
  ClientOptionsSchema,
  ServerOptionsSchema
} from './schemas';
import type { AuthorizationServerOptions } from './schemas';
import { withWireRecorder } from './validation/wire-schema';
import {
  loadExpectedFailures,
  evaluateBaseline,
  printBaselineResults
} from './expected-failures';
import { createTierCheckCommand } from './tier-check';
import { createNewSepCommand } from './new-sep';
import { createSdkCommand } from './sdk-runner';
import { createTraceabilityCommand } from './traceability';
import packageJson from '../package.json';

// Note on naming: `command` refers to which CLI command is calling this.
// The `client` command tests Scenario objects (which test clients),
// and the `server` command tests ClientScenario objects (which test servers).
// This matches the inverted naming in scenarios/index.ts.
function filterScenariosBySpecVersion(
  allScenarios: string[],
  version: SpecVersion,
  command: 'client' | 'server' | 'authorization'
): string[] {
  let versionScenarios: string[];
  if (command === 'client') {
    versionScenarios = listScenariosForSpec(version);
  } else if (command === 'server') {
    versionScenarios = listClientScenariosForSpec(version);
  } else if (command === 'authorization') {
    versionScenarios =
      listClientScenariosForAuthorizationServerForSpec(version);
  } else {
    versionScenarios = [];
  }
  const allowed = new Set(versionScenarios);
  return allScenarios.filter((s) => allowed.has(s));
}

const EXTENSION_SELECTION_NOTE =
  'Note: --extensions/--exclude-extensions apply to --suite selection; a lone --scenario runs regardless.';

/** Add the shared --extensions/--exclude-extensions option pair to a command. */
function withExtensionSelectionOptions(cmd: Command): Command {
  return cmd
    .option(
      '--extensions <ids>',
      'Comma-separated extension IDs: keep only these extensions\' scenarios in the selected suite (spec-timeline scenarios are unaffected; "none" deselects all extension scenarios)'
    )
    .addOption(
      new Option(
        '--exclude-extensions <ids>',
        'Comma-separated extension IDs whose scenarios are deselected from the selected suite ("none" deselects nothing; mutually exclusive with --extensions)'
      ).conflicts('extensions')
    );
}

/**
 * Parse `--extensions` / `--exclude-extensions` (commander enforces their
 * mutual exclusion) into an extension selection, or undefined when neither
 * is given (all extension scenarios stay selected, the historical behavior).
 * `none` is accepted by both: `--extensions none` deselects every extension
 * scenario, `--exclude-extensions none` deselects nothing.
 */
function parseExtensionSelection(options: {
  extensions?: string;
  excludeExtensions?: string;
}): ExtensionSelection | undefined {
  if (options.extensions !== undefined) {
    return { mode: 'include', ids: resolveExtensionIds(options.extensions) };
  }
  if (options.excludeExtensions !== undefined) {
    return {
      mode: 'exclude',
      ids: resolveExtensionIds(options.excludeExtensions)
    };
  }
  return undefined;
}

/**
 * Apply the extension selection to a suite's scenario list, logging what was
 * deselected. An empty result is an error: a run whose selection removes
 * every scenario (or whose --spec-version already removed all extension
 * scenarios the selection asked for) should fail loudly, not exit 0 having
 * tested nothing.
 */
function applyExtensionSelection(
  scenarios: string[],
  selection: ExtensionSelection | undefined
): string[] {
  if (!selection) return scenarios;
  const { kept, dropped } = filterScenariosByExtensions(scenarios, selection);
  if (dropped.length > 0) {
    console.log(
      `Deselected ${dropped.length} extension scenario(s): ${dropped.join(', ')}\n`
    );
  }
  if (selection.mode === 'include') {
    // Asking to include an extension that contributes nothing to the
    // selected suite (wrong suite, or --spec-version already removed its
    // scenarios) must not silently pass as if it were tested. Excluding an
    // absent extension, by contrast, is a satisfied no-op — including when
    // the suite was already empty before the selection.
    const unmatched = selection.ids.filter(
      (id) => !kept.some((name) => getScenarioExtensionId(name) === id)
    );
    if (unmatched.length > 0) {
      console.error(
        `No scenarios for extension(s) ${unmatched.join(', ')} in the selected suite; check --suite and --spec-version`
      );
      process.exit(1);
    }
  }
  if (kept.length === 0 && dropped.length > 0) {
    console.error(
      'The extension selection deselected every scenario in the suite; check --suite and --extensions/--exclude-extensions'
    );
    process.exit(1);
  }
  return kept;
}

const program = new Command();

program
  .name('conformance')
  .description('MCP Conformance Test Suite')
  .version(packageJson.version);

// Client command - tests a client implementation against scenarios
withExtensionSelectionOptions(
  program
    .command('client')
    .description(
      'Run conformance tests against a client implementation or start interactive mode'
    )
    .option('--command <command>', 'Command to run the client')
    .option('--scenario <scenario>', 'Scenario to test')
    .option(
      '--suite <suite>',
      'Run a suite of tests in parallel (e.g., "auth")'
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
    .option(
      '--force',
      'Run a scenario even if it is not applicable at the requested --spec-version'
    )
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

      const extensionSelection = parseExtensionSelection(options);

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
          draft: listDraftScenarios,
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
        scenarios = applyExtensionSelection(scenarios, extensionSelection);
        console.log(
          `Running ${suiteName} suite (${scenarios.length} scenarios) in parallel...\n`
        );

        const results = await Promise.all(
          scenarios.map(async (scenarioName) => {
            try {
              // Each concurrent scenario records wire violations into its own
              // AsyncLocalStorage-scoped recorder (see withWireRecorder).
              const result = await withWireRecorder(() =>
                runConformanceTest(
                  options.command,
                  scenarioName,
                  timeout,
                  outputDir,
                  specVersionFilter,
                  options.force ?? false
                )
              );
              return {
                scenario: scenarioName,
                checks: result.checks,
                skipped: result.skipped,
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
                skipped: undefined,
                error
              };
            }
          })
        );

        console.log('\n=== SUITE SUMMARY ===\n');

        let totalPassed = 0;
        let totalFailed = 0;
        let totalWarnings = 0;
        let totalSkipped = 0;

        for (const result of results) {
          // Inapplicable scenario/spec-version combination (already logged by
          // the runner). Not a failure: report distinctly.
          if (result.skipped) {
            totalSkipped++;
            console.log(`- ${result.scenario}: skipped`);
            continue;
          }

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

        const skippedStr = totalSkipped > 0 ? `, ${totalSkipped} skipped` : '';
        console.log(
          `\nTotal: ${totalPassed} passed, ${totalFailed} failed, ${totalWarnings} warnings${skippedStr}`
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
          '\nAvailable suites: all, core, extensions, backcompat, auth, metadata, draft, sep-835'
        );
        process.exit(1);
      }

      if (extensionSelection) {
        console.log(EXTENSION_SELECTION_NOTE);
      }

      // Validate options with Zod for single scenario mode
      const validated = ClientOptionsSchema.parse(options);

      // If no command provided, run in interactive mode
      if (!validated.command) {
        await runInteractiveMode(
          validated.scenario,
          verbose,
          outputDir,
          specVersionFilter,
          options.force ?? false
        );
        process.exit(0);
      }

      // Otherwise run conformance test
      const result = await runConformanceTest(
        validated.command,
        validated.scenario,
        timeout,
        outputDir,
        specVersionFilter,
        options.force ?? false
      );

      // Inapplicable scenario/spec-version combination (already logged by
      // the runner). Not a failure: exit 0.
      if (result.skipped) {
        process.exit(0);
      }

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
        error.issues.forEach((err) => {
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
withExtensionSelectionOptions(
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
      'Suite to run: "active" (default, excludes pending and draft), "all", "draft", or "pending"',
      'active'
    )
    .option(
      '--expected-failures <path>',
      'Path to YAML file listing expected failures (baseline)'
    )
    .option('-o, --output-dir <path>', 'Save results to this directory')
    .option(
      '--spec-version <version>',
      'Filter scenarios by spec version (cumulative for date versions)'
    )
    .option(
      '--force',
      'Run a scenario even if it is not applicable at the requested --spec-version'
    )
)
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .action(async (options) => {
    try {
      // Validate options with Zod
      const validated = ServerOptionsSchema.parse(options);

      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;
      const specVersionFilter = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

      const extensionSelection = parseExtensionSelection(options);

      // If a single scenario is specified, run just that one
      if (validated.scenario) {
        if (extensionSelection) {
          console.log(EXTENSION_SELECTION_NOTE);
        }

        const result = await runServerConformanceTest(
          validated.url,
          validated.scenario,
          outputDir,
          specVersionFilter,
          options.force ?? false
        );

        // Inapplicable scenario/spec-version combination (already logged by
        // the runner). Not a failure: exit 0.
        if (result.skipped) {
          process.exit(0);
        }

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
        } else if (suite === 'draft') {
          // Scenarios targeting the in-progress draft spec; excluded from
          // 'active' until the draft is published as a dated release.
          scenarios = listDraftClientScenarios();
        } else {
          console.error(`Unknown suite: ${suite}`);
          console.error('Available suites: active, all, core, draft, pending');
          process.exit(1);
        }

        if (specVersionFilter) {
          scenarios = filterScenariosBySpecVersion(
            scenarios,
            specVersionFilter,
            'server'
          );
        }
        scenarios = applyExtensionSelection(scenarios, extensionSelection);

        console.log(
          `Running ${suite} suite (${scenarios.length} scenarios) against ${validated.url}\n`
        );

        const allResults: { scenario: string; checks: ConformanceCheck[] }[] =
          [];

        for (const scenarioName of scenarios) {
          console.log(`\n=== Running scenario: ${scenarioName} ===`);
          try {
            // Sequential, but a failed scenario can leak a connection that
            // emits late traffic; scoping keeps it out of the next scenario.
            const result = await withWireRecorder(() =>
              runServerConformanceTest(
                validated.url,
                scenarioName,
                outputDir,
                specVersionFilter
              )
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
        error.issues.forEach((err) => {
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

// Authorization command - tests an authorization server implementation
program
  .command('authorization')
  .description(
    'Run conformance tests against an authorization server implementation'
  )
  .option(
    '--file <filename>',
    'Path to JSON settings file (see examples/authorization-server-settings.example.json)'
  )
  .option('--url <url>', 'URL of the authorization server issuer')
  .option('--scenario <scenario>', 'Test scenario to run')
  .option(
    '--client-id <id>',
    'OAuth client ID registered with the authorization server'
  )
  .option(
    '--client-secret <secret>',
    'OAuth client secret (omit for public/PKCE-only clients)'
  )
  .option(
    '-p, --port <port>',
    'Port for the local OAuth callback server; register http://127.0.0.1:<port>/callback as a redirect URI',
    (value) => Number(value),
    3000
  )
  .option('-o, --output-dir <path>', 'Save results to this directory')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .action(async (options) => {
    try {
      let fileOptions: AuthorizationServerOptions | undefined;
      if (options.file) {
        try {
          const raw = JSON.parse(await fs.readFile(options.file, 'utf-8'));
          // The file must be a complete, valid config on its own; CLI flags
          // are optional overrides. .strict() rejects unknown keys so typos
          // surface instead of being silently ignored.
          fileOptions = AuthorizationServerOptionsSchema.strict().parse(raw);
        } catch (error) {
          if (error instanceof ZodError) {
            const details = error.issues
              .map((e) => `  ${e.path.join('.') || '(root)'}: ${e.message}`)
              .join('\n');
            console.error(
              `Invalid settings file '${options.file}':\n${details}`
            );
          } else {
            console.error(
              `Failed to read settings file '${options.file}': ` +
                (error instanceof Error ? error.message : String(error))
            );
          }
          process.exit(1);
        }
      }
      if (!fileOptions && !options.url) {
        console.error('error: must provide --url or --file');
        process.exit(1);
      }
      // CLI flags override file values; undefined CLI values must not clobber file values
      const merged = {
        ...fileOptions,
        ...Object.fromEntries(
          Object.entries(options).filter(([, v]) => v !== undefined)
        )
      };
      const validated = AuthorizationServerOptionsSchema.parse(merged);
      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;
      const specVersionFilter = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

      // If a single scenario is specified, run just that one
      if (validated.scenario) {
        const details: Record<string, unknown> = {};
        const result = await runAuthorizationServerConformanceTest(
          validated,
          validated.scenario,
          details,
          outputDir,
          specVersionFilter
        );

        const { failed } = printAuthorizationServerResults(
          result.checks,
          result.scenarioDescription,
          verbose
        );

        process.exit(failed > 0 ? 1 : 0);
      }

      let scenarios: string[];
      scenarios = listClientScenariosForAuthorizationServer();
      if (specVersionFilter) {
        scenarios = filterScenariosBySpecVersion(
          scenarios,
          specVersionFilter,
          'authorization'
        );
      }
      console.log(
        `Running test (${scenarios.length} scenarios) against ${validated.url}\n`
      );

      const allResults: { scenario: string; checks: ConformanceCheck[] }[] = [];
      const details: Record<string, unknown> = {};
      for (const scenarioName of scenarios) {
        console.log(`\n=== Running scenario: ${scenarioName} ===`);
        try {
          const result = await runAuthorizationServerConformanceTest(
            validated,
            scenarioName,
            details,
            outputDir,
            specVersionFilter
          );
          if (
            result.checks[0].status === 'SUCCESS' &&
            result.checks[0].details
          ) {
            details[scenarioName] = result.checks[0].details;
          }
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
      const { totalFailed } = printAuthorizationServerSummary(allResults);
      process.exit(totalFailed > 0 ? 1 : 0);
    } catch (error) {
      if (error instanceof ZodError) {
        console.error('Validation error:');
        error.issues.forEach((err) => {
          console.error(`  ${err.path.join('.')}: ${err.message}`);
        });
        console.error('\nAvailable authorization server scenarios:');
        listClientScenariosForAuthorizationServer().forEach((s) =>
          console.error(`  - ${s}`)
        );
        process.exit(1);
      }
      console.error('Authorization server test error:', error);
      process.exit(1);
    }
  });

// Tier check command
program.addCommand(createTierCheckCommand());

// New SEP scaffolding command
program.addCommand(createNewSepCommand());

// SDK command - run local conformance against an SDK at a specific ref
program.addCommand(createSdkCommand());

// SEP traceability manifest command
program.addCommand(createTraceabilityCommand());

// List scenarios command
program
  .command('list')
  .description('List available test scenarios')
  .option('--client', 'List client scenarios')
  .option('--server', 'List server scenarios')
  .option('--authorization', 'List authorization server scenarios')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .option(
    '--extensions <ids>',
    'Preview an extension selection: list only these extensions\' scenarios plus spec-timeline scenarios ("none" hides all extension scenarios)'
  )
  .addOption(
    new Option(
      '--exclude-extensions <ids>',
      "Preview an extension deselection: hide these extensions' scenarios (mutually exclusive with --extensions)"
    ).conflicts('extensions')
  )
  .action((options) => {
    const specVersionFilter = options.specVersion
      ? resolveSpecVersion(options.specVersion)
      : undefined;
    const extensionSelection = parseExtensionSelection(options);
    // Listing is a preview: filter silently, no fail-loud checks.
    const applySelection = (names: string[]): string[] =>
      extensionSelection
        ? filterScenariosByExtensions(names, extensionSelection).kept
        : names;

    if (
      options.server ||
      (!options.client && !options.server && !options.authorization)
    ) {
      console.log('Server scenarios (test against a server):');
      let serverScenarios = listClientScenarios();
      if (specVersionFilter) {
        serverScenarios = filterScenariosBySpecVersion(
          serverScenarios,
          specVersionFilter,
          'server'
        );
      }
      serverScenarios = applySelection(serverScenarios);
      serverScenarios.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }

    if (
      options.client ||
      (!options.client && !options.server && !options.authorization)
    ) {
      if (options.server || (!options.client && !options.server)) {
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
      clientScenarioNames = applySelection(clientScenarioNames);
      clientScenarioNames.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }

    if (
      options.authorization ||
      (!options.authorization && !options.server && !options.client)
    ) {
      if (!(options.authorization && !options.server && !options.client)) {
        console.log('');
      }
      console.log(
        'Authorization server scenarios (test against an authorization server):'
      );
      let authorizationServerScenarios =
        listClientScenariosForAuthorizationServer();
      if (specVersionFilter) {
        authorizationServerScenarios = filterScenariosBySpecVersion(
          authorizationServerScenarios,
          specVersionFilter,
          'authorization'
        );
      }
      authorizationServerScenarios = applySelection(
        authorizationServerScenarios
      );
      authorizationServerScenarios.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }
  });

program.parse();
