import { describe, it, expect } from 'vitest';
import {
  listScenarios,
  listScenariosForSpec,
  listDraftScenarios,
  listExtensionScenarios,
  getScenario,
  getScenarioSpecVersions,
  resolveSpecVersion,
  ALL_SPEC_VERSIONS,
  scenarios
} from './index';
import {
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION
} from '../types';

describe('specVersions helpers', () => {
  // The ScenarioSource union (introducedIn XOR extensionId) is enforced by the
  // type system; no runtime invariant test is needed.

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
        const src = scenarios.get(name)!.source;
        if ('extensionId' in src || src.removedIn === undefined) continue;
        if (vIdx >= ALL_SPEC_VERSIONS.indexOf(src.removedIn)) {
          expect(
            selected.has(name),
            `scenario "${name}" (removedIn ${src.removedIn}) should not appear in --spec-version ${v}`
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

  it('every scenario in latest but not in draft is explicitly removedIn: DRAFT', () => {
    const latest = new Set(listScenariosForSpec(LATEST_SPEC_VERSION));
    const draft = new Set(listScenariosForSpec(DRAFT_PROTOCOL_VERSION));
    for (const name of latest) {
      if (!draft.has(name)) {
        const s = getScenario(name)!;
        expect(
          'removedIn' in s.source && s.source.removedIn,
          `"${name}" is in ${LATEST_SPEC_VERSION} but not in draft without removedIn`
        ).toBe(DRAFT_PROTOCOL_VERSION);
      }
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
