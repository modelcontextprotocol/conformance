/**
 * The client scenarios the hosted server can mount, known without loading
 * them.
 *
 * Importing the scenario registry (../scenarios) evaluates every scenario
 * module: the auth scenarios with their JOSE and SDK dependencies, and the
 * server-side scenarios the hosted server never runs. A serverless isolate
 * pays for that before it can answer its first request, and a client that
 * gives `server/discover` a second falls back to an older handshake. So the
 * hosted layer builds the matrix from metadata generated from the registry
 * (./scenario-catalog.ts, `npm run hosted:bundle-catalog`) and imports a
 * scenario's module the first time a request needs the scenario itself.
 */

import type { Scenario } from '../types';
import type { ScenarioMeta } from './scenario-meta';
import { SCENARIO_CATALOG } from './scenario-catalog';

type Loader = () => Promise<Scenario>;

/**
 * One loader per scenario, constructed as the registry constructs it. The
 * specifiers are literals so a deploy that stages the import closure
 * (examples/hosted/deploy-valtown.ts) finds every module.
 */
const LOADERS = new Map<string, Loader>([
  [
    'initialize',
    async () =>
      new (await import('../scenarios/client/initialize')).InitializeScenario()
  ],
  [
    'tools_call',
    async () =>
      new (await import('../scenarios/client/tools_call')).ToolsCallScenario()
  ],
  [
    'elicitation-sep1034-client-defaults',
    async () =>
      new (
        await import('../scenarios/client/elicitation-defaults')
      ).ElicitationClientDefaultsScenario()
  ],
  [
    'sse-retry',
    async () =>
      new (await import('../scenarios/client/sse-retry')).SSERetryScenario()
  ],
  [
    'request-metadata',
    async () =>
      new (
        await import('../scenarios/client/request-metadata')
      ).RequestMetadataScenario()
  ],
  [
    'sep-2322-client-request-state',
    async () =>
      new (await import('../scenarios/client/mrtr-client')).MRTRClientScenario()
  ],
  [
    'http-standard-headers',
    async () =>
      new (
        await import('../scenarios/client/http-standard-headers')
      ).HttpStandardHeadersScenario()
  ],
  [
    'http-custom-headers',
    async () =>
      new (
        await import('../scenarios/client/http-custom-headers')
      ).HttpCustomHeadersScenario()
  ],
  [
    'http-invalid-tool-headers',
    async () =>
      new (
        await import('../scenarios/client/http-custom-headers')
      ).HttpInvalidToolHeadersScenario()
  ],
  [
    'json-schema-ref-no-deref',
    async () =>
      new (
        await import('../scenarios/client/json-schema-ref-deref')
      ).JsonSchemaRefDerefScenario()
  ],
  [
    'json-schema-2020-12-preservation',
    async () =>
      new (
        await import('../scenarios/client/json-schema-2020-12-preservation')
      ).JsonSchema2020_12PreservationScenario()
  ],
  [
    'sep-2640-client-no-prefetch',
    async () =>
      new (
        await import('../scenarios/client/skills/no-prefetch')
      ).SkillsNoPrefetchScenario()
  ],
  [
    'sep-2640-client-verify-digest',
    async () =>
      new (
        await import('../scenarios/client/skills/verification')
      ).SkillsVerificationScenario('digest')
  ],
  [
    'sep-2640-client-verify-size',
    async () =>
      new (
        await import('../scenarios/client/skills/verification')
      ).SkillsVerificationScenario('size')
  ],
  [
    'sep-2640-client-verify-frontmatter',
    async () =>
      new (
        await import('../scenarios/client/skills/verification')
      ).SkillsVerificationScenario('frontmatter')
  ]
]);

/**
 * The auth scenarios share their helpers (the authorization server, JOSE),
 * so they load together, as the same instances the registry lists.
 */
async function authScenario(name: string): Promise<Scenario> {
  const auth = await import('../scenarios/client/auth/index');
  const found = [
    ...auth.authScenariosList,
    ...auth.backcompatScenariosList,
    ...auth.draftScenariosList,
    ...auth.extensionScenariosList
  ].find((s) => s.name === name);
  if (!found) throw new Error(`no auth scenario '${name}'`);
  return found;
}

/** How to load the scenario named `name`; undefined when there is no way. */
export function scenarioLoader(name: string): Loader | undefined {
  const loader = LOADERS.get(name);
  if (loader) return loader;
  if (name.startsWith('auth/')) return () => authScenario(name);
  return undefined;
}

export class ScenarioCatalog {
  private readonly metas: ReadonlyMap<string, ScenarioMeta>;
  private readonly loaded = new Map<string, Scenario>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    metas: readonly ScenarioMeta[],
    private readonly loaderFor: (name: string) => Loader | undefined
  ) {
    this.metas = new Map(metas.map((m) => [m.name, m]));
  }

  /** Every scenario's name, in registry order. */
  get names(): string[] {
    return Array.from(this.metas.keys());
  }

  has(name: string): boolean {
    return this.metas.has(name);
  }

  meta(name: string): ScenarioMeta | undefined {
    return this.metas.get(name);
  }

  /** Every scenario's metadata, in registry order. */
  all(): ScenarioMeta[] {
    return Array.from(this.metas.values());
  }

  /** The scenarios loaded so far, in the order they finished loading. */
  loadedNames(): string[] {
    return Array.from(this.loaded.keys());
  }

  /**
   * The registered instance of a loaded scenario; undefined for a name the
   * catalog does not have. A known scenario that is not loaded yet throws:
   * the caller skipped load(), which is a bug to see, not a cell to report
   * as unknown.
   */
  get(name: string): Scenario | undefined {
    const scenario = this.loaded.get(name);
    if (scenario) return scenario;
    if (this.metas.has(name)) {
      throw new Error(
        `scenario '${name}' is not loaded; await hostedScenarios.load() before using it`
      );
    }
    return undefined;
  }

  /** Load the scenarios of `names` not loaded yet; unknown names are skipped. */
  load(names: Iterable<string>): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const name of names) {
      if (this.loaded.has(name) || !this.metas.has(name)) continue;
      pending.push(this.loadOne(name));
    }
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending).then(() => undefined);
  }

  loadAll(): Promise<void> {
    return this.load(this.metas.keys());
  }

  private loadOne(name: string): Promise<void> {
    const inFlight = this.loading.get(name);
    if (inFlight) return inFlight;
    const loader = this.loaderFor(name);
    if (!loader) {
      return Promise.reject(new Error(`no loader for scenario '${name}'`));
    }
    // A failed import is not remembered: the next request tries again.
    const attempt = loader()
      .then((scenario) => {
        if (scenario.name !== name) {
          throw new Error(
            `the loader for '${name}' produced '${scenario.name}'`
          );
        }
        this.loaded.set(name, scenario);
      })
      .finally(() => this.loading.delete(name));
    this.loading.set(name, attempt);
    return attempt;
  }
}

/** The catalog the hosted server uses. */
export const hostedScenarios = new ScenarioCatalog(
  SCENARIO_CATALOG,
  scenarioLoader
);
