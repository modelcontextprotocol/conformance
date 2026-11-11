import { describe, it, expect } from 'vitest';
import {
  listScenarios,
  listScenariosForSpec,
  listDraftScenarios,
  listDraftClientScenarios,
  listActiveClientScenarios,
  listExtensionScenarios,
  getScenario,
  getScenarioSpecVersions,
  matchesSpecVersion,
  resolveSpecVersion,
  defaultSpecVersionFor,
  ALL_SPEC_VERSIONS,
  scenarios,
  clientScenarios
} from './index';
import {
  DATED_SPEC_VERSIONS,
  DRAFT_SPEC_VERSION,
  LATEST_SPEC_VERSION
} from '../types';
import { listRequirementRevisions } from '../requirements';

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

  it('2026-07-28 drops the stateful-lifecycle scenarios and adds its own', () => {
    const previous = new Set(listScenariosForSpec('2025-11-25'));
    const current = new Set(listScenariosForSpec('2026-07-28'));
    // removedIn: '2026-07-28'
    expect(previous.has('initialize')).toBe(true);
    expect(current.has('initialize')).toBe(false);
    // introducedIn: '2026-07-28'
    expect(previous.has('request-metadata')).toBe(false);
    expect(current.has('request-metadata')).toBe(true);
    expect(current.has('auth/iss-supported')).toBe(true);
    // carried forward
    expect(current.has('tools_call')).toBe(true);
  });

  it('every scenario in latest but not in draft is explicitly removedIn: draft', () => {
    const latest = new Set(listScenariosForSpec(LATEST_SPEC_VERSION));
    const draft = new Set(listScenariosForSpec(DRAFT_SPEC_VERSION));
    for (const name of latest) {
      if (!draft.has(name)) {
        const s = getScenario(name)!;
        expect(
          'removedIn' in s.source && s.source.removedIn,
          `"${name}" is in ${LATEST_SPEC_VERSION} but not in draft without removedIn`
        ).toBe(DRAFT_SPEC_VERSION);
      }
    }
    for (const name of listDraftScenarios()) {
      expect(draft.has(name)).toBe(true);
    }
  });

  it('LATEST_SPEC_VERSION has a frozen requirement set', () => {
    // tier-check defaults to the latest requirement set; promoting a new
    // dated revision without freezing its requirements would leave that
    // default pointing at the previous release.
    expect(listRequirementRevisions()).toContain(LATEST_SPEC_VERSION);
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

  it("resolveSpecVersion accepts 'draft' and dated versions", () => {
    expect(resolveSpecVersion('draft')).toBe(DRAFT_SPEC_VERSION);
    expect(resolveSpecVersion('2026-07-28')).toBe('2026-07-28');
    expect(resolveSpecVersion(LATEST_SPEC_VERSION)).toBe(LATEST_SPEC_VERSION);
  });

  describe('defaultSpecVersionFor', () => {
    it('uses the latest release for scenarios that apply there', () => {
      expect(defaultSpecVersionFor({ introducedIn: '2025-06-18' })).toBe(
        LATEST_SPEC_VERSION
      );
      expect(defaultSpecVersionFor({ introducedIn: LATEST_SPEC_VERSION })).toBe(
        LATEST_SPEC_VERSION
      );
    });
    it('uses the draft for draft-only scenarios', () => {
      expect(defaultSpecVersionFor({ introducedIn: DRAFT_SPEC_VERSION })).toBe(
        DRAFT_SPEC_VERSION
      );
    });
    it('uses the last release before removedIn for removed scenarios', () => {
      expect(
        defaultSpecVersionFor({
          introducedIn: '2025-06-18',
          removedIn: '2026-07-28'
        })
      ).toBe('2025-11-25');
      expect(
        defaultSpecVersionFor({
          introducedIn: '2025-03-26',
          removedIn: '2025-06-18'
        })
      ).toBe('2025-03-26');
    });
    it('uses the latest release for extensions', () => {
      expect(
        defaultSpecVersionFor({ extensionId: 'io.modelcontextprotocol/tasks' })
      ).toBe(LATEST_SPEC_VERSION);
    });
  });

  describe('matchesSpecVersion (per-check gating)', () => {
    const src = { introducedIn: '2025-11-25' } as const;
    it.each(['2025-11-25', '2026-07-28', DRAFT_SPEC_VERSION] as const)(
      'includes %s',
      (v) => expect(matchesSpecVersion(src, v)).toBe(true)
    );
    it.each(['2025-03-26', '2025-06-18'] as const)('excludes %s', (v) =>
      expect(matchesSpecVersion(src, v)).toBe(false)
    );
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

describe('draft suite membership', () => {
  it('every scenario introduced in the draft spec is selected by its draft suite', () => {
    const draftClientTesting = new Set(listDraftScenarios());
    for (const [name, scenario] of scenarios) {
      if (
        'introducedIn' in scenario.source &&
        scenario.source.introducedIn === DRAFT_SPEC_VERSION
      ) {
        expect(
          draftClientTesting.has(name),
          `client-testing scenario "${name}" should be in the draft suite`
        ).toBe(true);
      }
    }

    const draftServerTesting = new Set(listDraftClientScenarios());
    for (const [name, scenario] of clientScenarios) {
      if (
        'introducedIn' in scenario.source &&
        scenario.source.introducedIn === DRAFT_SPEC_VERSION
      ) {
        expect(
          draftServerTesting.has(name),
          `server-testing scenario "${name}" should be in the draft suite`
        ).toBe(true);
      }
    }
  });

  it('scenarios that shipped in 2026-07-28 are in the default suites, not draft', () => {
    const draft = new Set(listDraftScenarios());
    expect(draft.has('request-metadata')).toBe(false);
    expect(draft.has('http-standard-headers')).toBe(false);
    expect(draft.has('sep-2322-client-request-state')).toBe(false);

    const active = new Set(listActiveClientScenarios());
    expect(active.has('server-stateless')).toBe(true);
    expect(active.has('caching')).toBe(true);
    expect(active.has('input-required-result-basic-elicitation')).toBe(true);
  });

  it('draft server-testing scenarios are excluded from the active suite', () => {
    const active = new Set(listActiveClientScenarios());
    for (const name of listDraftClientScenarios()) {
      expect(
        active.has(name),
        `draft scenario "${name}" should not be in the active suite`
      ).toBe(false);
    }
  });
});
