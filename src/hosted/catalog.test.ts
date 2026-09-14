import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scenarios } from '../scenarios';
import { CATALOG_PATH, registryCatalog, renderCatalog } from './bundle-catalog';
import { SCENARIO_CATALOG } from './scenario-catalog';
import { hostedScenarios, ScenarioCatalog, scenarioLoader } from './catalog';
import { scenarioMeta } from './scenario-meta';
import { freshScenario } from './session';

describe('hosted scenario catalog', () => {
  it('the committed catalog matches the registry (run `npm run hosted:bundle-catalog`)', () => {
    const fromRegistry = registryCatalog();
    expect(SCENARIO_CATALOG).toEqual(fromRegistry);
    const text = readFileSync(CATALOG_PATH, 'utf8');
    expect(text).toBe(renderCatalog(fromRegistry));
    // val.town caps files at 80,000 characters.
    expect(text.length).toBeLessThan(80_000);
  });

  it('lists every client scenario in registry order', () => {
    expect(hostedScenarios.names).toEqual(Array.from(scenarios.keys()));
  });

  it('loads every scenario as the registry constructs it', async () => {
    await hostedScenarios.loadAll();
    for (const [name, registered] of scenarios) {
      const loaded = hostedScenarios.get(name)!;
      expect(loaded.constructor, name).toBe(registered.constructor);
      expect(scenarioMeta(loaded), name).toEqual(scenarioMeta(registered));
      expect(freshScenario(loaded).name, name).toBe(
        freshScenario(registered).name
      );
    }
  });

  it('refuses a scenario used before it is loaded, and loads only what is asked', async () => {
    const catalog = new ScenarioCatalog(SCENARIO_CATALOG, scenarioLoader);
    expect(() => catalog.get('tools_call')).toThrow(/not loaded/);
    expect(catalog.get('no-such-scenario')).toBeUndefined();
    await catalog.load(['tools_call', 'no-such-scenario']);
    expect(catalog.loadedNames()).toEqual(['tools_call']);
    expect(catalog.get('tools_call')?.name).toBe('tools_call');
  });

  it('tries a failed load again on the next request', async () => {
    let calls = 0;
    const catalog = new ScenarioCatalog(SCENARIO_CATALOG, (name) => () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('flaky import'));
      return scenarioLoader(name)!();
    });
    await expect(catalog.load(['initialize'])).rejects.toThrow('flaky import');
    expect(catalog.loadedNames()).toEqual([]);
    await catalog.load(['initialize']);
    expect(catalog.loadedNames()).toEqual(['initialize']);
  });
});
