import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUNDLE_PATH,
  readRequirementSources,
  renderBundle
} from './bundle-requirements';
import { REQUIREMENT_SOURCES } from './requirements-bundle';
import {
  listRequirementRevisions,
  loadRequirements,
  registerRequirementSources
} from '../../src/requirements';

describe('bundled requirement sets', () => {
  const fromDisk = readRequirementSources();

  it('the committed bundle matches requirements/*.yaml (run `npm run hosted:bundle-requirements`)', () => {
    expect(REQUIREMENT_SOURCES).toEqual(fromDisk);
    expect(readFileSync(BUNDLE_PATH, 'utf8')).toBe(renderBundle(fromDisk));
    // val.town caps files at 80,000 characters.
    expect(readFileSync(BUNDLE_PATH, 'utf8').length).toBeLessThan(80_000);
  });

  it('round-trips a bundled revision through registerRequirementSources()', () => {
    const revision = Object.keys(REQUIREMENT_SOURCES)[0];
    const fromFile = loadRequirements(revision);
    // Register under a name the disk does not have to prove the registered
    // text is what gets parsed, then under its own name.
    registerRequirementSources({ [revision]: REQUIREMENT_SOURCES[revision] });
    expect(loadRequirements(revision)).toEqual(fromFile);
    expect(listRequirementRevisions()).toContain(revision);
    // Registered text goes through the same validation as a file.
    registerRequirementSources({ '2025-06-18': 'sever:\n  - x\n' });
    expect(listRequirementRevisions()).toContain('2025-06-18');
    expect(() => loadRequirements('2025-06-18')).toThrow(/unknown key "sever"/);
  });
});
