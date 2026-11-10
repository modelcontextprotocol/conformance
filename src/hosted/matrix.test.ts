import { describe, it, expect } from 'vitest';
import { buildMatrix, notApplicableReason, scoringFor } from './matrix';
import { loadRequirements } from '../requirements';
import { getScenario } from '../scenarios';

describe('hosted matrix', () => {
  const requirements = loadRequirements('2026-07-28');

  it("classifies cells against the revision's requirement set", () => {
    const at = (name: string) => scoringFor(getScenario(name)!, requirements);
    expect(at('tools_call')).toEqual({ scoring: 'scored' });
    expect(at('auth/dpop')).toEqual({
      scoring: 'not_scored',
      reason: 'extension'
    });
    expect(at('initialize')).toEqual({
      scoring: 'n/a',
      reason: 'introduced in 2025-06-18, removed in 2026-07-28'
    });
    // Off-timeline extension the set does not list.
    expect(at('sep-2640-client-no-prefetch')).toEqual({
      scoring: 'n/a',
      reason: 'extension, not on the spec timeline'
    });
    // Applicable but absent from the frozen set.
    expect(
      scoringFor(
        { name: 'brand-new-scenario', source: { introducedIn: '2025-11-25' } },
        requirements
      )
    ).toEqual({ scoring: 'unlisted', reason: 'not in the requirement set' });
  });

  it('carries the not_scored note into the reason', () => {
    const cell = scoringFor(
      { name: 'x', source: { introducedIn: '2025-11-25' } },
      {
        revision: '2026-07-28',
        server: [],
        client: [],
        notScored: [
          { scenario: 'x', leg: 'client', reason: 'pending', note: 'why' }
        ]
      }
    );
    expect(cell).toEqual({ scoring: 'not_scored', reason: 'pending: why' });
  });

  it('words applicability like the CLI', () => {
    expect(notApplicableReason({ introducedIn: '2026-07-28' })).toBe(
      'introduced in 2026-07-28'
    );
    expect(
      notApplicableReason({
        extensionId: 'io.modelcontextprotocol/skills'
      })
    ).toBe('extension, not on the spec timeline');
  });

  it('derives startability from handlers, relay origins and exclusions', () => {
    const bare = buildMatrix();
    expect(bare.revisions).toEqual(['2025-11-25', '2026-07-28']);
    expect(bare.rows.map((r) => r.scenario)).toContain('auth/basic-cimd');
    expect(bare.cell('auth/basic-cimd', '2025-11-25')).toMatchObject({
      scoring: 'scored',
      startable: false,
      startReason: 'needs relay origin(s) [as]'
    });
    expect(bare.cell('auth/scope-step-up', '2025-11-25')).toMatchObject({
      startable: false,
      startReason: 'not converted for hosting yet'
    });
    // n/a cells are never startable and carry no start reason.
    expect(bare.cell('initialize', '2026-07-28')).toMatchObject({
      scoring: 'n/a',
      startable: false
    });
    expect(bare.cell('initialize', '2026-07-28')!.startReason).toBeUndefined();
    expect(bare.cell('tools_call', '2026-07-28')).toMatchObject({
      startable: true,
      mcpPath: '/mcp'
    });
    expect(bare.cell('tools_call', '2026-07-28')!.steps).toBeDefined();

    const withRelay = buildMatrix({
      auxOrigins: { as: 'https://as.example' },
      exclude: { tools_call: 'nope' }
    });
    expect(withRelay.cell('auth/basic-cimd', '2025-11-25')!.startable).toBe(
      true
    );
    expect(withRelay.cell('tools_call', '2026-07-28')).toMatchObject({
      startable: false,
      startReason: 'nope'
    });
    expect(bare.cell('nope', '2026-07-28')).toBeUndefined();
  });
});
