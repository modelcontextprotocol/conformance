import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import {
  filterScenariosByRequirements,
  listRequirementRevisions,
  loadRequirements,
  notScoredScenarios,
  requirementsExitCode,
  scenariosToRun,
  scoredScenarios
} from './requirements';
import { listClientScenarios, listScenarios } from './scenarios';

const revisions = listRequirementRevisions();

describe('requirement sets', () => {
  it('ships at least one revision', () => {
    expect(revisions.length).toBeGreaterThan(0);
  });

  describe.each(revisions)('%s', (revision) => {
    const requirements = loadRequirements(revision);

    // A requirement set is frozen, so a name it asks for that this build does
    // not have means a scenario was renamed or removed out from under a shipped
    // revision. That silently shrinks what conformance means, so it fails here.
    it.each([
      ['server', requirements.server, listClientScenarios()],
      ['client', requirements.client, listScenarios()]
    ])(
      'every %s scenario exists in this build',
      (_leg, required, available) => {
        expect(required.filter((name) => !available.includes(name))).toEqual(
          []
        );
      }
    );

    it('lists no scenario twice within a leg', () => {
      for (const leg of [requirements.server, requirements.client]) {
        expect(new Set(leg).size).toBe(leg.length);
      }
    });

    it('keeps not-scored entries out of the required lists', () => {
      const required = new Set([
        ...requirements.server,
        ...requirements.client
      ]);
      const alsoRequired = requirements.notScored
        .map((e) => e.scenario)
        .filter((name) => required.has(name));
      expect(alsoRequired).toEqual([]);
    });

    it('runs the not-scored entries alongside the required ones', () => {
      for (const leg of ['server', 'client'] as const) {
        const run = scenariosToRun(requirements, leg);
        const scored = scoredScenarios(requirements, leg);
        const extra = notScoredScenarios(requirements, leg).map(
          (e) => e.scenario
        );
        expect(run).toEqual([...scored, ...extra]);
        expect(extra.every((name) => !scored.includes(name))).toBe(true);
      }
    });
  });
});

describe('loadRequirements', () => {
  it('rejects anything that is not a revision date', () => {
    expect(() => loadRequirements('../../etc/passwd')).toThrow(
      /Invalid requirements revision/
    );
    expect(() => loadRequirements('latest')).toThrow(
      /Invalid requirements revision/
    );
  });

  it('rejects a date that is not a spec revision, since it also names the wire', () => {
    expect(() => loadRequirements('1999-01-01')).toThrow(
      /Unknown spec revision: 1999-01-01/
    );
  });

  it('names the available revisions when a known one has no set', () => {
    expect(() => loadRequirements('2025-03-26')).toThrow(
      /No requirement set for 2025-03-26/
    );
  });
});

describe('loadRequirements validation', () => {
  // The files are the frozen contract: a malformed one must fail loudly, never
  // silently shrink what conformance means.
  const path = 'requirements/2026-07-28.yaml';
  const original = readFileSync(path, 'utf-8');
  afterEach(() => writeFileSync(path, original));

  it('rejects an unknown top-level key instead of silently dropping a leg', () => {
    writeFileSync(path, original.replace('\nserver:\n', '\nsever:\n'));
    expect(() => loadRequirements('2026-07-28')).toThrow(/unknown key "sever"/);
  });

  it('rejects a scenario that is both scored and not_scored', () => {
    writeFileSync(
      path,
      original.replace(
        'not_scored:',
        'not_scored:\n  - scenario: tools-list\n    leg: server\n    reason: extension'
      )
    );
    expect(() => loadRequirements('2026-07-28')).toThrow(/both scored/);
  });

  it('rejects duplicate scored entries', () => {
    writeFileSync(
      path,
      original.replace('  - tools-list\n', '  - tools-list\n  - tools-list\n')
    );
    expect(() => loadRequirements('2026-07-28')).toThrow(/duplicate server/);
  });
});

describe('filterScenariosByRequirements', () => {
  const requirements = loadRequirements(revisions[0]);

  it('returns what the revision runs, not the suite it was given', () => {
    const selected = filterScenariosByRequirements(
      listClientScenarios(),
      requirements,
      'server'
    );
    expect(selected).toEqual(scenariosToRun(requirements, 'server'));
  });

  describe('requirementsExitCode', () => {
    const requirements = {
      revision: '2026-07-28',
      server: ['scored-scenario'],
      client: [],
      notScored: [
        {
          scenario: 'post-release-scenario',
          leg: 'server' as const,
          reason: 'added-after-release' as const
        }
      ]
    };
    const warningCheck = {
      id: 'should-check',
      name: 'ShouldCheck',
      description: 'A SHOULD-level check',
      status: 'WARNING' as const,
      timestamp: new Date().toISOString()
    };

    it('fails when a scored scenario emits a warning', () => {
      expect(
        requirementsExitCode(requirements, 'server', [
          { scenario: 'scored-scenario', checks: [warningCheck] }
        ])
      ).toBe(1);
    });

    it('does not fail when only a not-scored scenario emits a warning', () => {
      expect(
        requirementsExitCode(requirements, 'server', [
          { scenario: 'post-release-scenario', checks: [warningCheck] }
        ])
      ).toBe(0);
    });

    it('does not fail when a scored scenario emits diagnostic information', () => {
      expect(
        requirementsExitCode(requirements, 'server', [
          {
            scenario: 'scored-scenario',
            checks: [{ ...warningCheck, status: 'INFO' }]
          }
        ])
      ).toBe(0);
    });
  });

  it('runs the not-scored entries but keeps them out of the scored set', () => {
    const selected = filterScenariosByRequirements(
      listClientScenarios(),
      requirements,
      'server'
    );
    const extensions = notScoredScenarios(requirements, 'server').map(
      (e) => e.scenario
    );
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.every((name) => selected.includes(name))).toBe(true);
    expect(
      extensions.some((name) =>
        scoredScenarios(requirements, 'server').includes(name)
      )
    ).toBe(false);
  });

  it('fails loudly when the build is missing a required scenario', () => {
    expect(() =>
      filterScenariosByRequirements(
        ['nothing-it-asks-for'],
        requirements,
        'server'
      )
    ).toThrow(/does not provide/);
  });
});
