import { describe, it, expect } from 'vitest';
import {
  listScenarios,
  listClientScenarios,
  listScenariosForSpec,
  listDraftScenarios,
  listExtensionScenarios,
  getScenarioSpecVersions,
  resolveSpecVersion,
  ALL_SPEC_VERSIONS,
  scenarios,
  clientScenarios
} from './index';
import {
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION,
  ScenarioSpecTag
} from '../types';

const ALL_SCENARIO_SPEC_TAGS: ScenarioSpecTag[] = [
  ...ALL_SPEC_VERSIONS,
  'extension'
];

describe('specVersions helpers', () => {
  it('every Scenario has introducedIn', () => {
    for (const name of listScenarios()) {
      const s = scenarios.get(name);
      expect(s, `scenario "${name}" missing from map`).toBeDefined();
      if (s!.extension) continue;
      expect(
        s!.introducedIn,
        `scenario "${name}" is missing introducedIn`
      ).toBeDefined();
      expect(ALL_SCENARIO_SPEC_TAGS).toContain(s!.introducedIn);
      if (s!.removedIn !== undefined) {
        expect(ALL_SCENARIO_SPEC_TAGS).toContain(s!.removedIn);
      }
    }
  });

  it('every ClientScenario has introducedIn', () => {
    for (const name of listClientScenarios()) {
      const s = clientScenarios.get(name);
      expect(s, `client scenario "${name}" missing from map`).toBeDefined();
      if (s!.extension) continue;
      expect(
        s!.introducedIn,
        `client scenario "${name}" is missing introducedIn`
      ).toBeDefined();
      expect(ALL_SCENARIO_SPEC_TAGS).toContain(s!.introducedIn);
      if (s!.removedIn !== undefined) {
        expect(ALL_SCENARIO_SPEC_TAGS).toContain(s!.removedIn);
      }
    }
  });

  it('listScenariosForSpec returns scenarios whose range covers that version', () => {
    const selected = listScenariosForSpec('2025-06-18');
    expect(selected.length).toBeGreaterThan(0);
    for (const name of selected) {
      const tags = getScenarioSpecVersions(name);
      expect(tags).toContain('2025-06-18');
    }
  });

  it('scenarios with removedIn do not appear in versions at or after the cutoff', () => {
    for (const v of ALL_SPEC_VERSIONS) {
      const selected = new Set(listScenariosForSpec(v));
      const vIdx = ALL_SPEC_VERSIONS.indexOf(v);
      for (const name of listScenarios()) {
        const s = scenarios.get(name)!;
        if (s.extension || s.removedIn === undefined) continue;
        if (vIdx >= ALL_SPEC_VERSIONS.indexOf(s.removedIn)) {
          expect(
            selected.has(name),
            `scenario "${name}" (removedIn ${s.removedIn}) should not appear in --spec-version ${v}`
          ).toBe(false);
        }
      }
    }
  });

  it('2025-11-25 includes scenarios carried forward from 2025-06-18', () => {
    const base = listScenariosForSpec('2025-06-18');
    const current = listScenariosForSpec('2025-11-25');
    const currentSet = new Set(current);
    const overlap = base.filter((s) => currentSet.has(s));
    expect(overlap.length).toBeGreaterThan(0);
    expect(current.length).toBeGreaterThan(overlap.length);
  });

  it('the draft spec version is a superset of the latest dated release', () => {
    const latest = new Set(listScenariosForSpec(LATEST_SPEC_VERSION));
    const draft = new Set(listScenariosForSpec(DRAFT_PROTOCOL_VERSION));
    for (const name of latest) {
      expect(draft.has(name)).toBe(true);
    }
    for (const name of listDraftScenarios()) {
      expect(draft.has(name)).toBe(true);
    }
  });

  it('draft-introduced scenarios are not matched by any dated spec version', () => {
    for (const name of listDraftScenarios()) {
      for (const dated of DATED_SPEC_VERSIONS) {
        const selected = new Set(listScenariosForSpec(dated));
        expect(
          selected.has(name),
          `draft scenario "${name}" should not appear in --spec-version ${dated}`
        ).toBe(false);
      }
    }
  });

  it("resolveSpecVersion accepts 'draft' as an alias", () => {
    expect(resolveSpecVersion('draft')).toBe(DRAFT_PROTOCOL_VERSION);
    expect(resolveSpecVersion(LATEST_SPEC_VERSION)).toBe(LATEST_SPEC_VERSION);
  });

  it('extension-tagged scenarios are not selected by any --spec-version', () => {
    for (const version of ALL_SPEC_VERSIONS) {
      const selected = new Set(listScenariosForSpec(version));
      for (const name of listExtensionScenarios()) {
        expect(
          selected.has(name),
          `extension scenario "${name}" was selected by --spec-version ${version}`
        ).toBe(false);
      }
    }
  });
});
