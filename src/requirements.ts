import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { ALL_SPEC_VERSIONS } from './scenarios';
import type { ConformanceCheck } from './types';

/**
 * A frozen requirement set for one specification revision: the scenarios an
 * implementation must pass to conform to that revision, fixed when it shipped.
 *
 * This is the project's contract, not an implementation's configuration. It is
 * the opposite of an expected-failures baseline, which lives in an
 * implementation's own repository and records what that implementation knows it
 * fails. A baselined failure is still a failure against a requirement set.
 */
export interface RequirementSet {
  /** Revision this set belongs to, e.g. `2026-07-28`. */
  revision: string;
  /** Scenarios `conformance server` runs against a server implementation. */
  server: string[];
  /** Scenarios `conformance client` runs against a client implementation. */
  client: string[];
  /**
   * Scenarios run and reported alongside the required ones but never counted
   * toward a pass rate. Three reasons qualify, and the report names which:
   * an extension is optional by definition, a scenario added after the
   * revision shipped is one no implementation could have been passing, and a
   * pending scenario is one the suite's own reference fixture cannot pass yet
   * — the implementation under test still might, so it runs for visibility.
   */
  notScored: NotScored[];
}

export type NotScoredReason = 'extension' | 'added-after-release' | 'pending';

export interface NotScored {
  scenario: string;
  leg: Leg;
  reason: NotScoredReason;
  note?: string;
}

/**
 * Roles a requirement set covers. The MCP specification defines two: an MCP
 * server acting as an OAuth resource server, and an MCP client acting as an
 * OAuth client. Authorization-server implementation is explicitly beyond the
 * specification's scope, so those scenarios are not a conformance requirement
 * for anything the spec defines and have no place in a requirement set.
 */
export type Leg = 'client' | 'server';

const LEGS: Leg[] = ['client', 'server'];
export const REASONS: NotScoredReason[] = [
  'extension',
  'added-after-release',
  'pending'
];

/** Requirement sets ship with the package; see the `files` entry in package.json. */
function requirementsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'requirements');
}

export function listRequirementRevisions(): string[] {
  const dir = requirementsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

function asNameList(value: unknown, field: string, revision: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(
      `requirements/${revision}.yaml: "${field}" must be a list of scenario names`
    );
  }
  return value as string[];
}

export function loadRequirements(revision: string): RequirementSet {
  // A revision names a bundled file. Arbitrary paths are deliberately not
  // accepted: a requirement set is the project's contract, so an implementation
  // under test must not be able to supply its own.
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(revision)) {
    // A run has one exit code and one expected-failures baseline, so it targets
    // one revision. tier-check is the aggregator and takes several at once.
    throw new Error(
      revision.includes(',')
        ? `A run targets one revision at a time, because it has one exit code and one baseline. Run each of "${revision}" separately, or pass them together to \`tier-check --requirements\`.`
        : `Invalid requirements revision: ${revision}. Expected a date such as 2026-07-28.`
    );
  }

  // The revision is also the wire version its scenarios run at, so it has to be
  // a protocol version this build knows, not merely a date-shaped string.
  if (!(ALL_SPEC_VERSIONS as readonly string[]).includes(revision)) {
    throw new Error(
      `Unknown spec revision: ${revision}. Known revisions: ${ALL_SPEC_VERSIONS.join(', ')}`
    );
  }

  const path = join(requirementsDir(), `${revision}.yaml`);
  if (!existsSync(path)) {
    const known = listRequirementRevisions();
    throw new Error(
      `No requirement set for ${revision}.` +
        (known.length
          ? ` Available: ${known.join(', ')}`
          : ' No requirement sets are bundled with this release.')
    );
  }

  const parsed = parseYaml(readFileSync(path, 'utf-8')) ?? {};

  // A frozen contract must fail loudly on anything it does not recognise: a
  // typo'd key ("sever:") would otherwise silently empty a leg and the gate
  // would pass having required nothing.
  const KNOWN_KEYS = new Set(['server', 'client', 'not_scored']);
  for (const key of Object.keys(parsed)) {
    if (key === 'authorization') continue; // rejected below with its own reason
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(
        `requirements/${revision}.yaml: unknown key "${key}" (expected server, client, not_scored)`
      );
    }
  }
  const notScoredRaw = parsed.not_scored ?? [];
  if (!Array.isArray(notScoredRaw)) {
    throw new Error(
      `requirements/${revision}.yaml: "not_scored" must be a list`
    );
  }

  if (parsed.authorization !== undefined) {
    throw new Error(
      `requirements/${revision}.yaml: requirement sets cover the client and server roles only. ` +
        'Authorization-server implementation is beyond the scope of the MCP specification, so it is not a conformance requirement.'
    );
  }

  const server = asNameList(parsed.server, 'server', revision);
  const client = asNameList(parsed.client, 'client', revision);
  for (const [leg, names] of [
    ['server', server],
    ['client', client]
  ] as const) {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      throw new Error(
        `requirements/${revision}.yaml: duplicate ${leg} scenario(s): ${[...new Set(dupes)].join(', ')}`
      );
    }
  }

  return {
    revision,
    server,
    client,
    notScored: notScoredRaw.map((entry: unknown) => {
      const e = entry as NotScored;
      if (!e || typeof e.scenario !== 'string') {
        throw new Error(
          `requirements/${revision}.yaml: each not_scored entry needs a "scenario" name`
        );
      }
      if (!LEGS.includes(e.leg)) {
        throw new Error(
          `requirements/${revision}.yaml: ${e.scenario} needs a "leg" of ${LEGS.join(', ')}`
        );
      }
      if (!REASONS.includes(e.reason)) {
        throw new Error(
          `requirements/${revision}.yaml: ${e.scenario} needs a "reason" of ${REASONS.join(', ')}`
        );
      }
      // A half-finished promotion (a scenario both scored and not_scored)
      // would run twice and be counted inconsistently across code paths.
      const scoredNames = e.leg === 'server' ? server : client;
      if (scoredNames.includes(e.scenario)) {
        throw new Error(
          `requirements/${revision}.yaml: ${e.scenario} is both scored (${e.leg}) and not_scored — finish the promotion by removing one entry`
        );
      }
      return {
        scenario: e.scenario,
        leg: e.leg,
        reason: e.reason,
        note: e.note
      };
    })
  };
}

/** Scenarios that count toward the pass rate for a leg. */
export function scoredScenarios(
  requirements: RequirementSet,
  leg: Leg
): string[] {
  return requirements[leg];
}

/** Scenarios run and reported for a leg but excluded from the pass rate. */
export function notScoredScenarios(
  requirements: RequirementSet,
  leg: Leg
): NotScored[] {
  return requirements.notScored.filter((entry) => entry.leg === leg);
}

/** Everything a leg runs: what it scores, plus what it only reports. */
export function scenariosToRun(
  requirements: RequirementSet,
  leg: Leg
): string[] {
  return [
    ...scoredScenarios(requirements, leg),
    ...notScoredScenarios(requirements, leg).map((e) => e.scenario)
  ];
}

/**
 * Narrow a scenario list to the revision's requirements.
 *
 * Names the requirement set asks for that this build does not have are an
 * error: the set is frozen, so a missing name means the suite renamed or
 * removed a scenario out from under it, and silently scoring a smaller set
 * would understate what conformance means.
 */
export function filterScenariosByRequirements(
  allScenarios: string[],
  requirements: RequirementSet,
  leg: Leg
): string[] {
  const scored = new Set(scoredScenarios(requirements, leg));
  const available = new Set(allScenarios);
  const wanted = scenariosToRun(requirements, leg);
  // Only the scored names are a contract violation when absent. A not-scored
  // entry can legitimately postdate the build being run, which is the whole
  // reason it is listed separately.
  const missing = wanted.filter(
    (name) => !available.has(name) && scored.has(name)
  );
  if (missing.length > 0) {
    throw new Error(
      `requirements/${requirements.revision}.yaml lists ${leg} scenarios that this build does not provide: ${missing.join(', ')}`
    );
  }
  return wanted.filter((name) => available.has(name));
}

function isBlockingCheck(check: ConformanceCheck): boolean {
  return check.status === 'FAILURE' || check.status === 'WARNING';
}

/**
 * Exit status under a frozen requirement set. Scored failures and warnings
 * block conformance; not-scored scenarios are reported without changing it.
 */
export function requirementsExitCode(
  requirements: RequirementSet,
  leg: Leg,
  results: { scenario: string; checks: ConformanceCheck[] }[]
): number {
  const scored = new Set(scoredScenarios(requirements, leg));
  const unscored = results.filter((result) => !scored.has(result.scenario));
  if (unscored.length > 0) {
    const blocking = unscored.filter((result) =>
      result.checks.some(isBlockingCheck)
    );
    console.log(
      `\nNot scored for ${requirements.revision}: ${unscored.length} scenario(s) run, ${blocking.length} non-green. These do not affect conformance.`
    );
    for (const result of unscored) {
      const why = notScoredScenarios(requirements, leg).find(
        (entry) => entry.scenario === result.scenario
      );
      const isBlocking = result.checks.some(isBlockingCheck);
      console.log(
        `  ${isBlocking ? '\u2717' : '\u2713'} ${result.scenario} (${why?.reason ?? 'not scored'})`
      );
    }
  }

  const scoredBlocked = results
    .filter((result) => scored.has(result.scenario))
    .some((result) => result.checks.some(isBlockingCheck));
  return scoredBlocked ? 1 : 0;
}
