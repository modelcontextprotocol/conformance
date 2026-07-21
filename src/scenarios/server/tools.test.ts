import { describe, it, expect } from 'vitest';
import {
  buildToolsNameFormatCheck,
  toolNameFormatCheckApplies,
  ToolsListScenario,
  validateToolNameFormat
} from './tools.js';
import type { Connection, RunContext } from '../../connection';

describe('validateToolNameFormat', () => {
  it('accepts a typical snake_case name', () => {
    expect(validateToolNameFormat('test_simple_text')).toBeNull();
  });

  it('accepts all allowed character classes', () => {
    expect(validateToolNameFormat('Aa0_.-')).toBeNull();
  });

  it('accepts a single-character name (lower length boundary)', () => {
    expect(validateToolNameFormat('a')).toBeNull();
  });

  it('accepts a 128-character name (upper length boundary)', () => {
    expect(validateToolNameFormat('a'.repeat(128))).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateToolNameFormat('')).toMatch(/length 0 is outside/);
  });

  it('rejects a 129-character name', () => {
    expect(validateToolNameFormat('a'.repeat(129))).toMatch(
      /length 129 is outside/
    );
  });

  it('rejects forward slash (allowed in SEP-986 markdown but not spec prose)', () => {
    expect(validateToolNameFormat('namespace/tool')).toMatch(
      /contains characters outside/
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
      { name: 'admin.tools.list' }
    ]);
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
    expect(check.details).toMatchObject({
      toolCount: 2,
      results: {
        test_simple_text: 'valid',
        'admin.tools.list': 'valid'
      }
    });
  });

  it('returns WARNING with per-tool details when some names are invalid', () => {
    const check = buildToolsNameFormatCheck([
      { name: 'good_tool' },
      { name: 'bad name with spaces' },
      { name: 'a'.repeat(129) }
    ]);

    expect(check.status).toBe('WARNING');
    expect(check.errorMessage).toContain(
      '2 tool name(s) violate spec Tool Names SHOULD rules'
    );

    const results = (check.details as { results: Record<string, string> })
      .results;
    expect(results['good_tool']).toBe('valid');
    expect(results['bad name with spaces']).toMatch(/^invalid: /);
    expect(results['a'.repeat(129)]).toMatch(/^invalid: length 129/);
  });

  it('flags a tool whose name is not a string', () => {
    const check = buildToolsNameFormatCheck([{ name: 123 as unknown }]);
    expect(check.status).toBe('WARNING');
    const results = (check.details as { results: Record<string, string> })
      .results;
    expect(results['<tool[0] missing name>']).toBe(
      'invalid: name is not a string'
    );
  });

  it('lists core spec Tool Names first, then SEP history for context', () => {
    const check = buildToolsNameFormatCheck([{ name: 'ok' }]);
    const ids = check.specReferences?.map((r) => r.id);
    expect(ids).toEqual([
      'MCP-Tool-Names',
      'MCP-Tool-Names-Draft',
      'SEP-986-History',
      'SEP-986-Spec-Integration'
    ]);
    expect(check.specReferences?.[0]?.url).toContain(
      '2025-11-25/server/tools#tool-names'
    );
    expect(check.specReferences?.[1]?.url).toContain(
      'draft/server/tools#tool-names'
    );
    expect(check.specReferences?.[2]?.url).toContain('issues/986');
    expect(check.specReferences?.[3]?.url).toContain('pull/1603');
  });
});

describe('toolNameFormatCheckApplies', () => {
  // Locks version gate: no tools-name-format on 2025-03-26 / 2025-06-18 (AGENTS.md).
  it('is false before 2025-11-25 and true from that version onward', () => {
    expect(toolNameFormatCheckApplies('2025-03-26')).toBe(false);
    expect(toolNameFormatCheckApplies('2025-06-18')).toBe(false);
    expect(toolNameFormatCheckApplies('2025-11-25')).toBe(true);
    expect(toolNameFormatCheckApplies('2026-07-28')).toBe(true);
  });
});

describe('ToolsListScenario version gate', () => {
  // Scenario-level gate: invalid names must not emit the check before 2025-11-25.
  function mockContext(
    specVersion: RunContext['specVersion'],
    tools: Array<{ name: string; description: string; inputSchema: object }>
  ): RunContext {
    const connection: Connection = {
      notifications: [],
      request: (async () => ({ tools })) as Connection['request'],
      discover: async () => ({}),
      close: async () => {}
    };

    return {
      serverUrl: 'http://example.test/mcp',
      specVersion,
      connect: async () => connection
    };
  }

  it('does not emit tools-name-format on 2025-06-18 even when names violate 2025-11-25 rules', async () => {
    const scenario = new ToolsListScenario();
    const checks = await scenario.run(
      mockContext('2025-06-18', [
        {
          name: 'bad name',
          description: 'invalid under 2025-11-25 rules',
          inputSchema: { type: 'object' }
        }
      ])
    );

    expect(checks.some((c) => c.id === 'tools-name-format')).toBe(false);
    expect(checks.find((c) => c.id === 'tools-list')?.status).toBe('SUCCESS');
  });

  it('emits tools-name-format on 2025-11-25 when names violate spec prose', async () => {
    const scenario = new ToolsListScenario();
    const checks = await scenario.run(
      mockContext('2025-11-25', [
        {
          name: 'bad name',
          description: 'invalid under 2025-11-25 rules',
          inputSchema: { type: 'object' }
        }
      ])
    );

    expect(checks.find((c) => c.id === 'tools-name-format')?.status).toBe(
      'WARNING'
    );
  });
});
