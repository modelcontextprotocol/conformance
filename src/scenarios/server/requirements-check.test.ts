import { describe, it, expect } from 'vitest';
import {
  hasServerCapability,
  hasServerExtension,
  evaluateScenarioRequirements
} from './requirements-check';
import { getClientScenario, listClientScenarios } from '../index';

describe('hasServerCapability', () => {
  it('matches top-level server capabilities when declared', () => {
    const caps = {
      tools: {},
      resources: { listChanged: true },
      prompts: {},
      logging: {},
      completions: {}
    };

    expect(hasServerCapability(caps, 'tools')).toBe(true);
    expect(hasServerCapability(caps, 'resources')).toBe(true);
    expect(hasServerCapability(caps, 'prompts')).toBe(true);
    expect(hasServerCapability(caps, 'logging')).toBe(true);
    expect(hasServerCapability(caps, 'completions')).toBe(true);
  });

  it('returns false when top-level capabilities are absent or undefined', () => {
    expect(hasServerCapability({}, 'tools')).toBe(false);
    expect(hasServerCapability({ resources: undefined }, 'resources')).toBe(
      false
    );
  });

  it('treats malformed non-undefined declarations as declared so validation runs', () => {
    expect(hasServerCapability({ resources: true }, 'resources')).toBe(true);
    expect(hasServerCapability({ tools: null }, 'tools')).toBe(true);
  });

  it('checks nested resources.subscribe capability flag', () => {
    expect(hasServerCapability({}, 'resources.subscribe')).toBe(false);
    expect(hasServerCapability({ resources: {} }, 'resources.subscribe')).toBe(
      false
    );
    expect(
      hasServerCapability(
        { resources: { subscribe: false } },
        'resources.subscribe'
      )
    ).toBe(false);
    expect(
      hasServerCapability(
        { resources: { subscribe: true } },
        'resources.subscribe'
      )
    ).toBe(true);
  });
});

describe('hasServerExtension', () => {
  it('detects declared extensions under capabilities.extensions', () => {
    expect(hasServerExtension({}, 'io.modelcontextprotocol/tasks')).toBe(false);
    expect(
      hasServerExtension({ extensions: {} }, 'io.modelcontextprotocol/tasks')
    ).toBe(false);
    expect(
      hasServerExtension(
        { extensions: { 'io.modelcontextprotocol/tasks': {} } },
        'io.modelcontextprotocol/tasks'
      )
    ).toBe(true);
    expect(
      hasServerExtension(
        { extensions: { 'io.modelcontextprotocol/skills': true } },
        'io.modelcontextprotocol/skills'
      )
    ).toBe(true);
  });
});

describe('evaluateScenarioRequirements', () => {
  it('returns null when scenario has no requirements', () => {
    expect(
      evaluateScenarioRequirements('server-initialize', undefined, {})
    ).toBeNull();
  });

  it('skips when required capabilities are missing', () => {
    const check = evaluateScenarioRequirements(
      'resources-list',
      { capabilities: ['resources'] },
      { tools: {} }
    );
    expect(check).toMatchObject({
      id: 'resources-list',
      status: 'SKIPPED',
      details: {
        skippedReason: 'missing-capability',
        missingCapabilities: ['resources']
      }
    });
  });

  it('evaluates anyCapability with OR semantics', () => {
    const skipped = evaluateScenarioRequirements(
      'caching',
      { anyCapability: ['tools', 'prompts', 'resources'] },
      { logging: {} }
    );
    expect(skipped).toMatchObject({
      id: 'caching',
      status: 'SKIPPED',
      details: {
        skippedReason: 'missing-capability',
        requiredAnyOf: ['tools', 'prompts', 'resources']
      }
    });

    const allowed = evaluateScenarioRequirements(
      'caching',
      { anyCapability: ['tools', 'prompts', 'resources'] },
      { tools: {} }
    );
    expect(allowed).toBeNull();
  });

  it('skips when required extensions are missing', () => {
    const check = evaluateScenarioRequirements(
      'sep-2640-skills-manifest',
      { extensions: ['io.modelcontextprotocol/skills'] },
      { tools: {} }
    );
    expect(check).toMatchObject({
      id: 'sep-2640-skills-manifest',
      status: 'SKIPPED',
      details: {
        skippedReason: 'missing-extension',
        missingExtensions: ['io.modelcontextprotocol/skills']
      }
    });
  });

  it('skips fixture-bound scenarios after capabilities are satisfied', () => {
    const missingCapFirst = evaluateScenarioRequirements(
      'tools-call-simple-text',
      { capabilities: ['tools'], fixture: true },
      {}
    );
    expect(missingCapFirst?.details?.skippedReason).toBe('missing-capability');

    const fixtureSkip = evaluateScenarioRequirements(
      'tools-call-simple-text',
      { capabilities: ['tools'], fixture: true },
      { tools: {} }
    );
    expect(fixtureSkip).toMatchObject({
      id: 'tools-call-simple-text',
      status: 'SKIPPED',
      details: {
        skippedReason: 'requires-fixture',
        scenario: 'tools-call-simple-text'
      }
    });
  });
});

describe('server scenario requires metadata inventory', () => {
  it('keeps base protocol scenarios free of optional capability and fixture gates', () => {
    const baseProtocolScenarios = [
      'server-initialize',
      'server-session-lifecycle',
      'ping',
      'dns-rebinding-protection',
      'server-stateless'
    ];
    for (const name of baseProtocolScenarios) {
      const scenario = getClientScenario(name);
      expect(scenario, name).toBeDefined();
      expect(scenario?.requires, name).toBeUndefined();
    }
  });

  it('marks generic capability scenarios without fixture: true', () => {
    const genericCapabilityScenarios: Array<[string, string[]]> = [
      ['tools-list', ['tools']],
      ['resources-list', ['resources']],
      ['sep-2164-resource-not-found', ['resources']],
      ['prompts-list', ['prompts']],
      ['logging-set-level', ['logging']],
      ['server-sse-multiple-streams', ['tools']],
      ['http-header-validation', ['tools']]
    ];
    for (const [name, expectedCaps] of genericCapabilityScenarios) {
      const scenario = getClientScenario(name);
      expect(scenario?.requires?.capabilities, name).toEqual(expectedCaps);
      expect(scenario?.requires?.fixture, name).toBeUndefined();
    }

    const caching = getClientScenario('caching');
    expect(caching?.requires).toEqual({
      anyCapability: ['tools', 'prompts', 'resources']
    });
  });

  it('marks reference-fixture scenarios with fixture: true', () => {
    const allNames = listClientScenarios();
    const fixturePrefixes = [
      'tools-call-',
      'prompts-get-',
      'resources-read-',
      'resources-templates-read',
      'resources-subscribe',
      'resources-unsubscribe',
      'completion-complete',
      'json-schema-2020-12',
      'elicitation-sep',
      'server-sse-polling',
      'http-custom-header-server-validation',
      'tasks-'
    ];

    for (const name of allNames) {
      if (fixturePrefixes.some((prefix) => name.startsWith(prefix))) {
        const scenario = getClientScenario(name);
        expect(scenario?.requires?.fixture, name).toBe(true);
      }
    }
  });
});
