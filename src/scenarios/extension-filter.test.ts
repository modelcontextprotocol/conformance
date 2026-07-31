import { describe, it, expect } from 'vitest';
import {
  resolveExtensionIds,
  getScenarioExtensionId,
  filterScenariosByExtensions
} from './index';

describe('resolveExtensionIds', () => {
  it('accepts full extension IDs', () => {
    expect(resolveExtensionIds('io.modelcontextprotocol/tasks')).toEqual([
      'io.modelcontextprotocol/tasks'
    ]);
  });

  it('accepts IDs without the io.modelcontextprotocol/ prefix', () => {
    expect(resolveExtensionIds('auth/dpop,tasks')).toEqual([
      'io.modelcontextprotocol/auth/dpop',
      'io.modelcontextprotocol/tasks'
    ]);
  });

  it('trims whitespace and ignores empty segments', () => {
    expect(resolveExtensionIds(' auth/wif , ')).toEqual([
      'io.modelcontextprotocol/auth/wif'
    ]);
  });
});

describe('getScenarioExtensionId', () => {
  it('returns the extension ID for extension-tagged scenarios', () => {
    // Client-testing scenario (registered in the client `scenarios` map).
    expect(getScenarioExtensionId('auth/dpop')).toBe(
      'io.modelcontextprotocol/auth/dpop'
    );
    // Server-testing scenario (registered in the `clientScenarios` map).
    expect(getScenarioExtensionId('tasks-lifecycle')).toBe(
      'io.modelcontextprotocol/tasks'
    );
  });

  it('returns undefined for spec-timeline scenarios', () => {
    expect(getScenarioExtensionId('initialize')).toBeUndefined();
    expect(getScenarioExtensionId('server-stateless')).toBeUndefined();
  });

  it('returns undefined for unknown scenarios', () => {
    expect(getScenarioExtensionId('no-such-scenario')).toBeUndefined();
  });
});

describe('filterScenariosByExtensions', () => {
  const names = [
    'initialize',
    'auth/dpop',
    'auth/dpop-nonce',
    'auth/wif-jwt-bearer',
    'auth/client-credentials-basic'
  ];

  it('include mode keeps spec-timeline scenarios plus only the listed extensions', () => {
    const { kept, dropped } = filterScenariosByExtensions(names, {
      mode: 'include',
      ids: ['io.modelcontextprotocol/auth/dpop']
    });
    expect(kept).toEqual(['initialize', 'auth/dpop', 'auth/dpop-nonce']);
    expect(dropped).toEqual([
      'auth/wif-jwt-bearer',
      'auth/client-credentials-basic'
    ]);
  });

  it('an empty include list (--extensions none) drops every extension scenario', () => {
    const { kept, dropped } = filterScenariosByExtensions(names, {
      mode: 'include',
      ids: []
    });
    expect(kept).toEqual(['initialize']);
    expect(dropped).toHaveLength(4);
  });

  it('exclude mode drops only the listed extensions', () => {
    const { kept, dropped } = filterScenariosByExtensions(names, {
      mode: 'exclude',
      ids: [
        'io.modelcontextprotocol/auth/dpop',
        'io.modelcontextprotocol/auth/wif'
      ]
    });
    expect(kept).toEqual(['initialize', 'auth/client-credentials-basic']);
    expect(dropped).toEqual([
      'auth/dpop',
      'auth/dpop-nonce',
      'auth/wif-jwt-bearer'
    ]);
  });

  it('an empty exclude list (--exclude-extensions none) keeps everything', () => {
    const { kept, dropped } = filterScenariosByExtensions(names, {
      mode: 'exclude',
      ids: []
    });
    expect(kept).toEqual(names);
    expect(dropped).toEqual([]);
  });
});
