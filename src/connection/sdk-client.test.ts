import { describe, it, expect } from 'vitest';
import { reportSetupFailure } from './sdk-client';

describe('reportSetupFailure', () => {
  it('emits a single FAILURE check id-d "<scenario>-setup"', () => {
    const checks = reportSetupFailure(
      'tools-list',
      new Error('connect ECONNREFUSED')
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'tools-list-setup',
      status: 'FAILURE',
      errorMessage: 'Setup failed: connect ECONNREFUSED'
    });
  });

  it('stringifies a non-Error thrown value', () => {
    const checks = reportSetupFailure('prompts-list', 'boom');

    expect(checks[0]?.errorMessage).toBe('Setup failed: boom');
  });

  it('attaches spec references when provided and omits the field otherwise', () => {
    const withRefs = reportSetupFailure('resources-list', new Error('nope'), [
      { id: 'MCP-Resources-List' }
    ]);
    expect(withRefs[0]?.specReferences).toEqual([{ id: 'MCP-Resources-List' }]);

    const withoutRefs = reportSetupFailure('resources-list', new Error('nope'));
    expect(withoutRefs[0]).not.toHaveProperty('specReferences');
  });

  it('sets a timestamp', () => {
    const checks = reportSetupFailure('server-initialize', new Error('x'));
    expect(typeof checks[0]?.timestamp).toBe('string');
    expect(checks[0]?.timestamp.length).toBeGreaterThan(0);
  });
});
