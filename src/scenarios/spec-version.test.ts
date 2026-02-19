import { describe, it, expect } from 'vitest';
import {
  listScenarios,
  listClientScenarios,
  listScenariosForSpec,
  getScenarioSpecVersions,
  ALL_SPEC_VERSIONS
} from './index';

describe('specVersions helpers', () => {
  it('every Scenario has specVersions', () => {
    for (const name of listScenarios()) {
      const versions = getScenarioSpecVersions(name);
      expect(
        versions,
        `scenario "${name}" is missing specVersions`
      ).toBeDefined();
      expect(versions!.length).toBeGreaterThan(0);
      for (const v of versions!) {
        expect(ALL_SPEC_VERSIONS).toContain(v);
      }
    }
  });

  it('every ClientScenario has specVersions', () => {
    for (const name of listClientScenarios()) {
      const versions = getScenarioSpecVersions(name);
      expect(
        versions,
        `client scenario "${name}" is missing specVersions`
      ).toBeDefined();
      expect(versions!.length).toBeGreaterThan(0);
      for (const v of versions!) {
        expect(ALL_SPEC_VERSIONS).toContain(v);
      }
    }
  });

  it('listScenariosForSpec returns scenarios that include that version', () => {
    const scenarios = listScenariosForSpec('2025-06-18');
    expect(scenarios.length).toBeGreaterThan(0);
    for (const name of scenarios) {
      expect(getScenarioSpecVersions(name)).toContain('2025-06-18');
    }
  });

  it('2025-11-25 includes scenarios carried forward from 2025-06-18', () => {
    const base = listScenariosForSpec('2025-06-18');
    const current = listScenariosForSpec('2025-11-25');
    // scenarios tagged with both versions should appear in both lists
    const currentSet = new Set(current);
    // at least some overlap (carried-forward scenarios)
    const overlap = base.filter((s) => currentSet.has(s));
    expect(overlap.length).toBeGreaterThan(0);
    // current should have more total (new 2025-11-25-only scenarios)
    expect(current.length).toBeGreaterThan(overlap.length);
  });

  it('2025-11-25 does not include 2025-03-26-only scenarios', () => {
    const backcompat = listScenariosForSpec('2025-03-26');
    const current = listScenariosForSpec('2025-11-25');
    const currentSet = new Set(current);
    // backcompat-only scenarios should not appear in 2025-11-25
    for (const name of backcompat) {
      const versions = getScenarioSpecVersions(name)!;
      if (!versions.includes('2025-11-25')) {
        expect(currentSet.has(name)).toBe(false);
      }
    }
  });

  it('draft and extension scenarios are isolated', () => {
    const draft = listScenariosForSpec('draft');
    for (const name of draft) {
      expect(getScenarioSpecVersions(name)).toContain('draft');
    }
    const ext = listScenariosForSpec('extension');
    for (const name of ext) {
      expect(getScenarioSpecVersions(name)).toContain('extension');
    }
  });

  it('draft scenarios are not in dated versions', () => {
    const draft = listScenariosForSpec('draft');
    const dated = new Set([
      ...listScenariosForSpec('2025-03-26'),
      ...listScenariosForSpec('2025-06-18'),
      ...listScenariosForSpec('2025-11-25')
    ]);
    for (const name of draft) {
      expect(dated.has(name)).toBe(false);
    }
  });
});
