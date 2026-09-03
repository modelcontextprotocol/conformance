#!/usr/bin/env node

import { Command } from 'commander';
import { ZodError } from 'zod';
import { promises as fs } from 'fs';
import {
  runConformanceTest,
  printClientResults,
  runServerConformanceTest,
  printServerResults,
  printServerSummary,
  serverExitCode,
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
  resolveSpecVersion
} from './scenarios';
import type { SpecVersion } from './scenarios';
import { ConformanceCheck } from './types';
import {
  AuthorizationServerOptionsSchema,
  ClientOptionsSchema,
  ServerOptionsSchema
} from './schemas';
import type { AuthorizationServerOptions } from './schemas';
import { withWireRecorder } from './validation/wire-schema';
import {
  filterScenariosByRequirements,
  Leg,
  listRequirementRevisions,
  loadRequirements,
  REASONS,
  RequirementSet,
  requirementsExitCode,
  scoredScenarios
} from './requirements';
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
/**
 * Resolve `--requirements`. A requirement set replaces suite and spec-version
 * selection: it already names exactly the scenarios that revision requires.
 */
function resolveRequirements(
  revision: string | undefined,
  conflicts: { specVersion?: string; suiteFromCli?: boolean; scenario?: string }
): RequirementSet | undefined {
  if (revision === undefined) return undefined;
  // An explicitly passed empty value is a script whose variable did not expand.
  // Ignoring it would silently score against the whole suite, which is the
  // failure this flag exists to prevent.
  if (revision === '') {
    console.error(
      '--requirements needs a revision, such as 2026-07-28. Run `conformance list` to see which are available.'
    );
    process.exit(1);
  }
  const combined = conflicts.specVersion
    ? '--spec-version'
    : conflicts.suiteFromCli
      ? '--suite'
      : conflicts.scenario
        ? '--scenario'
        : undefined;
  if (combined) {
    console.error(
      `--requirements cannot be combined with ${combined}: a requirement set already fixes which scenarios run.`
    );
    process.exit(1);
  }
  try {
    return loadRequirements(revision);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/** Print one revision's requirement set. `list` is display-only, so it can show several. */
function listOneRequirementSet(revision: string, specVersion?: string): void {
  const requirements = resolveRequirements(revision, { specVersion })!;
  const legs: [string, string[]][] = [
    ['Server scenarios (test against a server)', requirements.server],
    ['Client scenarios (test against a client)', requirements.client]
  ];
  const total = legs.reduce((n, [, names]) => n + names.length, 0);
  console.log(
    `Required for ${requirements.revision} (${total} scenarios, frozen; run at the ${requirements.revision} wire):\n`
  );
  for (const [title, names] of legs) {
    if (names.length === 0) continue;
    console.log(`${title}:`);
    names.forEach((name) => console.log(`  - ${name}`));
    console.log('');
  }
  if (requirements.notScored.length > 0) {
    console.log('Run and reported, but never scored:');
    for (const reason of REASONS) {
      const entries = requirements.notScored.filter((e) => e.reason === reason);
      if (entries.length === 0) continue;
      console.log(`  ${reason} (${entries.length}):`);
      entries.forEach((e) => console.log(`    - ${e.scenario} [${e.leg}]`));
    }
    console.log('');
  }
}

function requiredScenariosOrExit(
  allScenarios: string[],
  requirements: RequirementSet,
  command: Leg
): string[] {
  try {
    return filterScenariosByRequirements(allScenarios, requirements, command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

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
  .option(
    '--force',
    'Run a scenario even if it is not applicable at the requested --spec-version'
  )
  .option(
    '--requirements <revision>',
    'Run exactly the scenarios a spec revision requires, frozen at its release (e.g. 2026-07-28). Replaces --suite and --spec-version'
  )
  .option('--verbose', 'Show verbose output')
  .action(async (options, cmd) => {
    try {
      const timeout = parseInt(options.timeout, 10);
      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;
      const requirements = resolveRequirements(options.requirements, {
        specVersion: options.specVersion,
        suiteFromCli: cmd.getOptionValueSource('suite') === 'cli',
        scenario: options.scenario
      });
      // A requirement set decides two different things, and only the first is
      // its scenario list. The revision it names is also the wire version those
      // scenarios must speak: 2025-11-25 and 2026-07-28 are different protocols
      // (stateful initialize handshake vs stateless per-request _meta), and a
      // scenario emits different checks under each. Leaving this unset ran the
      // right set against LATEST_SPEC_VERSION, which is a different wire than
      // the one named on the flag.
      const specVersionFilter = requirements
        ? resolveSpecVersion(requirements.revision)
        : options.specVersion
          ? resolveSpecVersion(options.specVersion)
          : undefined;

      // Handle suite mode
      if (options.suite || options.requirements !== undefined) {
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

        let scenarios: string[];
        let selection: string;
        if (requirements) {
          scenarios = requiredScenariosOrExit(
            listScenarios(),
            requirements,
            'client'
          );
          selection = `requirements ${requirements.revision}`;
        } else {
          const suiteName = options.suite.toLowerCase();
          if (!suites[suiteName]) {
            console.error(`Unknown suite: ${suiteName}`);
            console.error(
              `Available suites: ${Object.keys(suites).join(', ')}`
            );
            process.exit(1);
          }

          scenarios = suites[suiteName]();
          if (specVersionFilter) {
            scenarios = filterScenariosBySpecVersion(
              scenarios,
              specVersionFilter,
              'client'
            );
          }
          selection = `${suiteName} suite`;
        }
        console.log(
          `Running ${selection} (${scenarios.length} scenarios) in parallel...\n`
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
                  // a requirement set decides membership, so its choice outranks a
                  // scenario's own applicability window at the pinned revision
                  options.force || Boolean(requirements)
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
          // Under a requirement set, the baseline judges scored scenarios only:
          // a not_scored scenario cannot fail the run, so it must not surface
          // as an "unexpected failure" either.
          const scoredOnly = requirements
            ? new Set(scoredScenarios(requirements, 'client'))
            : undefined;
          const baselineResult = evaluateBaseline(
            scoredOnly
              ? results.filter((r) => scoredOnly.has(r.scenario))
              : results,
            baselineScenarios
          );
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

        process.exit(
          requirements
            ? requirementsExitCode(
                requirements,
                'client',
                results.map((r) => ({ scenario: r.scenario, checks: r.checks }))
              )
            : totalFailed > 0 || totalWarnings > 0
              ? 1
              : 0
        );
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
  .option(
    '--requirements <revision>',
    'Run exactly the scenarios a spec revision requires, frozen at its release (e.g. 2026-07-28). Replaces --suite and --spec-version'
  )
  .option('--verbose', 'Show verbose output (JSON instead of pretty print)')
  .action(async (options, cmd) => {
    try {
      // Validate options with Zod
      const validated = ServerOptionsSchema.parse(options);

      const verbose = options.verbose ?? false;
      const outputDir = options.outputDir;
      const requirements = resolveRequirements(options.requirements, {
        specVersion: options.specVersion,
        suiteFromCli: cmd.getOptionValueSource('suite') === 'cli',
        scenario: options.scenario
      });
      // A requirement set decides two different things, and only the first is
      // its scenario list. The revision it names is also the wire version those
      // scenarios must speak: 2025-11-25 and 2026-07-28 are different protocols
      // (stateful initialize handshake vs stateless per-request _meta), and a
      // scenario emits different checks under each. Leaving this unset ran the
      // right set against LATEST_SPEC_VERSION, which is a different wire than
      // the one named on the flag.
      const specVersionFilter = requirements
        ? resolveSpecVersion(requirements.revision)
        : options.specVersion
          ? resolveSpecVersion(options.specVersion)
          : undefined;

      // If a single scenario is specified, run just that one
      if (validated.scenario) {
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

        const { failed, warnings } = printServerResults(
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

        process.exit(serverExitCode(failed, warnings));
      } else {
        // Run scenarios based on suite
        const suite = options.suite?.toLowerCase() || 'active';
        let scenarios: string[];
        let selection = `${suite} suite`;

        if (requirements) {
          scenarios = requiredScenariosOrExit(
            listClientScenarios(),
            requirements,
            'server'
          );
          selection = `requirements ${requirements.revision}`;
        } else if (suite === 'all') {
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

        if (specVersionFilter && !requirements) {
          scenarios = filterScenariosBySpecVersion(
            scenarios,
            specVersionFilter,
            'server'
          );
        }

        console.log(
          `Running ${selection} (${scenarios.length} scenarios) against ${validated.url}\n`
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
                specVersionFilter,
                // a requirement set decides membership, so its choice outranks a
                // scenario's own applicability window at the pinned revision
                Boolean(requirements)
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

        const { totalFailed, totalWarnings } = printServerSummary(allResults);

        if (options.expectedFailures) {
          const expectedFailuresConfig = await loadExpectedFailures(
            options.expectedFailures
          );
          const baselineScenarios = expectedFailuresConfig.server ?? [];
          // Same scored-only rule as the client leg: not_scored scenarios are
          // outside both the pass rate and the baseline.
          const scoredOnly = requirements
            ? new Set(scoredScenarios(requirements, 'server'))
            : undefined;
          const baselineResult = evaluateBaseline(
            scoredOnly
              ? allResults.filter((r) => scoredOnly.has(r.scenario))
              : allResults,
            baselineScenarios
          );
          printBaselineResults(baselineResult);
          process.exit(baselineResult.exitCode);
        }

        process.exit(
          requirements
            ? requirementsExitCode(requirements, 'server', allResults)
            : serverExitCode(totalFailed, totalWarnings)
        );
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
  .description(
    `List available test scenarios. Requirement sets available: ${listRequirementRevisions().join(', ') || 'none'}`
  )
  .option('--client', 'List client scenarios')
  .option('--server', 'List server scenarios')
  .option('--authorization', 'List authorization server scenarios')
  .option(
    '--spec-version <version>',
    'Filter scenarios by spec version (cumulative for date versions)'
  )
  .option(
    '--requirements <revision>',
    'List exactly what a spec revision requires, frozen at its release'
  )
  .action((options) => {
    const specVersionFilter = options.specVersion
      ? resolveSpecVersion(options.specVersion)
      : undefined;

    if (options.requirements !== undefined) {
      for (const rev of String(options.requirements).split(',')) {
        listOneRequirementSet(rev.trim(), options.specVersion);
      }
      return;
    }

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
      authorizationServerScenarios.forEach((s) => {
        const v = getScenarioSpecVersions(s);
        console.log(`  - ${s}${v ? ` [${v}]` : ''}`);
      });
    }
  });

program.parse();
