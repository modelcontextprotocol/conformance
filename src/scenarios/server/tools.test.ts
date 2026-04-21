import { describe, it, expect } from 'vitest';
import { buildToolsNameFormatCheck, validateToolNameFormat } from './tools.js';

describe('validateToolNameFormat', () => {
  it('accepts a typical snake_case name', () => {
    expect(validateToolNameFormat('test_simple_text')).toBeNull();
  });

  it('accepts all allowed character classes', () => {
    expect(validateToolNameFormat('Aa0_.-/')).toBeNull();
  });

  it('accepts a single-character name (lower length boundary)', () => {
    expect(validateToolNameFormat('a')).toBeNull();
  });

  it('accepts a 64-character name (upper length boundary)', () => {
    expect(validateToolNameFormat('a'.repeat(64))).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateToolNameFormat('')).toMatch(/length 0 is outside/);
  });

  it('rejects a 65-character name', () => {
    expect(validateToolNameFormat('a'.repeat(65))).toMatch(
      /length 65 is outside/
    );
  });

  it.each([
    ['space', 'bad name'],
    ['colon', 'bad:name'],
    ['at sign', 'bad@name'],
    ['unicode', 'bad\u00e9name'],
    ['backslash', 'bad\\name'],
    ['plus', 'bad+name']
  ])('rejects a name with a disallowed character (%s)', (_label, name) => {
    expect(validateToolNameFormat(name)).toMatch(/contains characters outside/);
  });
});

describe('buildToolsNameFormatCheck', () => {
  it('returns INFO when tools is undefined', () => {
    const check = buildToolsNameFormatCheck(undefined);
    expect(check.status).toBe('INFO');
    expect(check.id).toBe('tools-name-format');
    expect(check.details).toEqual({ toolCount: 0 });
  });

  it('returns INFO when tools is an empty array', () => {
    const check = buildToolsNameFormatCheck([]);
    expect(check.status).toBe('INFO');
    expect(check.errorMessage).toBe('No tools advertised; nothing to validate');
  });

  it('returns SUCCESS when all tool names are valid', () => {
    const check = buildToolsNameFormatCheck([
      { name: 'test_simple_text' },
      { name: 'namespace/tool-v1.2' }
    ]);
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
    expect(check.details).toMatchObject({
      toolCount: 2,
      results: {
        test_simple_text: 'valid',
        'namespace/tool-v1.2': 'valid'
      }
    });
  });

  it('returns FAILURE with per-tool details when some names are invalid', () => {
    const check = buildToolsNameFormatCheck([
      { name: 'good_tool' },
      { name: 'bad name with spaces' },
      { name: 'a'.repeat(65) }
    ]);

    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain(
      '2 tool name(s) violate SEP-986 format'
    );

    const results = (check.details as { results: Record<string, string> })
      .results;
    expect(results['good_tool']).toBe('valid');
    expect(results['bad name with spaces']).toMatch(/^invalid: /);
    expect(results['a'.repeat(65)]).toMatch(/^invalid: length 65/);
  });

  it('flags a tool whose name is not a string', () => {
    const check = buildToolsNameFormatCheck([{ name: 123 as unknown }]);
    expect(check.status).toBe('FAILURE');
    const results = (check.details as { results: Record<string, string> })
      .results;
    expect(results['<tool[0] missing name>']).toBe(
      'invalid: name is not a string'
    );
  });

  it('includes both MCP-Tools-List and SEP-986 spec references', () => {
    const check = buildToolsNameFormatCheck([{ name: 'ok' }]);
    const ids = check.specReferences?.map((r) => r.id);
    expect(ids).toEqual(['MCP-Tools-List', 'SEP-986']);
  });
});
