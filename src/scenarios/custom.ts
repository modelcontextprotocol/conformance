/**
 * Loads client-testing scenarios from files outside this repository, so a
 * team can run its own scenarios through the same runner. See the README,
 * "Writing Your Own Scenarios".
 */
import { pathToFileURL } from 'url';
import {
  isSpecVersion,
  type CheckStatus,
  type ConformanceCheck,
  type Scenario
} from '../types';
import {
  getScenario,
  listClientScenarios,
  listClientScenariosForAuthorizationServer,
  listScenarios,
  registerScenario
} from './index';

const CHECK_STATUSES: readonly CheckStatus[] = [
  'SUCCESS',
  'FAILURE',
  'WARNING',
  'SKIPPED',
  'INFO'
];

// Names become directory names, baseline keys and summary lines.
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

const customScenarioNames = new Set<string>();

export function listCustomScenarios(): string[] {
  return Array.from(customScenarioNames);
}

export function isCustomScenario(name: string): boolean {
  return customScenarioNames.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Why `value` is not a usable scenario, or undefined when it is one. */
function scenarioProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  const { name, source } = value;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return `has the name ${JSON.stringify(name)}; use parts of letters, digits, '.', '_' and '-' that start with a letter or digit, with '/' between parts`;
  }
  if (typeof value.description !== 'string') return 'has no `description`';
  for (const method of ['start', 'stop', 'getChecks']) {
    if (typeof value[method] !== 'function') {
      return `has no \`${method}()\` method`;
    }
  }
  if (
    !isRecord(source) ||
    'extensionId' in source ||
    !isSpecVersion(source.introducedIn) ||
    (source.removedIn !== undefined && !isSpecVersion(source.removedIn))
  ) {
    return 'needs a `source` of known spec versions, `introducedIn` and optionally `removedIn`, and no `extensionId`';
  }
  return undefined;
}

/** Why `value` is not a usable check, or undefined when it is one. */
function checkProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  if (typeof value.id !== 'string' || value.id === '') return 'has no `id`';
  if (!CHECK_STATUSES.includes(value.status as CheckStatus)) {
    return `has the status ${JSON.stringify(value.status)}; use one of ${CHECK_STATUSES.join(', ')}`;
  }
  return undefined;
}

/**
 * The scenario as the runner sees it. A loaded scenario is untyped, so the
 * checks it returns are checked: a mistyped status must not read as a pass.
 */
function guarded(scenario: Scenario): Scenario {
  return {
    name: scenario.name,
    description: scenario.description,
    source: scenario.source,
    get allowClientError() {
      return scenario.allowClientError;
    },
    start: (ctx) => scenario.start(ctx),
    stop: async () => scenario.stop(),
    getChecks(): ConformanceCheck[] {
      const checks: unknown = scenario.getChecks();
      if (!Array.isArray(checks)) {
        throw new Error(
          `Scenario '${scenario.name}': getChecks() must return an array of checks`
        );
      }
      checks.forEach((check, index) => {
        const problem = checkProblem(check);
        if (problem !== undefined) {
          throw new Error(
            `Scenario '${scenario.name}': check ${index + 1} ${problem}`
          );
        }
      });
      return [...checks];
    }
  };
}

async function importScenarios(file: string): Promise<unknown[]> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: could not be loaded: ${reason}`);
  }
  const exported = isRecord(module) ? module.default : undefined;
  if (exported === undefined) {
    throw new Error(
      `${file}: no default export (export one scenario or an array of them)`
    );
  }
  const scenarios: unknown[] = Array.isArray(exported) ? exported : [exported];
  if (scenarios.length === 0) {
    throw new Error(`${file}: the default export is an empty array`);
  }
  return scenarios;
}

/**
 * Import each file and register the scenarios it default-exports (one
 * scenario or an array). Returns the registered names, in order. Throws,
 * registering nothing, if any file or scenario is unusable.
 */
export async function loadCustomScenarios(files: string[]): Promise<string[]> {
  // No name may match a scenario of any command, whatever its case.
  const taken = new Set(
    [
      ...listScenarios(),
      ...listClientScenarios(),
      ...listClientScenariosForAuthorizationServer()
    ].map((name) => name.toLowerCase())
  );
  const loaded: Scenario[] = [];

  for (const file of files) {
    const candidates = await importScenarios(file);
    candidates.forEach((candidate, index) => {
      const problem = scenarioProblem(candidate);
      if (problem !== undefined) {
        throw new Error(`${file}: scenario ${index + 1} ${problem}`);
      }
      const scenario = candidate as Scenario;
      if (taken.has(scenario.name.toLowerCase())) {
        throw new Error(
          `${file}: the scenario name '${scenario.name}' is already in use`
        );
      }
      taken.add(scenario.name.toLowerCase());
      loaded.push(scenario);
    });
  }

  for (const scenario of loaded) {
    registerScenario(scenario.name, guarded(scenario));
    customScenarioNames.add(scenario.name);
  }
  return loaded.map((scenario) => scenario.name);
}

export interface ScenarioFileOptions {
  scenarioFile?: string[];
  scenario?: string;
  suite?: string;
  requirements?: string;
}

/**
 * Apply `--scenario-file` to a command's options: load the files and, when
 * no scenario is named, select the `custom` suite. With files given, only
 * the scenarios they define can be selected; a conflicting option throws
 * before any file is imported.
 */
export async function applyScenarioFiles(
  options: ScenarioFileOptions
): Promise<string[]> {
  const files = options.scenarioFile ?? [];
  const suite = options.suite?.toLowerCase();
  if (files.length === 0) {
    if (suite === 'custom') {
      throw new Error('--suite custom needs at least one --scenario-file');
    }
    return [];
  }
  if (options.requirements !== undefined) {
    throw new Error(
      '--scenario-file cannot be combined with --requirements: a requirement set is fixed and never includes custom scenarios.'
    );
  }
  if (suite !== undefined && suite !== 'custom') {
    throw new Error(
      `--scenario-file cannot be combined with --suite ${options.suite}: loaded scenarios run as --suite custom or by --scenario <name>.`
    );
  }
  if (options.scenario !== undefined && getScenario(options.scenario)) {
    throw new Error(
      `--scenario-file cannot be combined with the built-in scenario '${options.scenario}': only loaded scenarios can be selected.`
    );
  }

  const names = await loadCustomScenarios(files);
  if (options.scenario === undefined) {
    options.suite = 'custom';
  } else if (!names.includes(options.scenario)) {
    throw new Error(
      `--scenario ${options.scenario} is not one of the loaded scenarios: ${names.join(', ')}`
    );
  }
  return names;
}
