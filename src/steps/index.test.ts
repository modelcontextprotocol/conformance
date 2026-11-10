import { describe, it, expect } from 'vitest';
import { StepsSchema, resolveFrom, resolveArguments } from './index';
import { getScenario } from '../scenarios';

describe('steps', () => {
  it('validates the closed op set', () => {
    expect(
      StepsSchema.safeParse([
        { op: 'tools/list' },
        { op: 'tools/call', name: 'x', arguments: { a: 1 } },
        { op: 'wait', ms: 10 },
        { op: 'disconnect' }
      ]).success
    ).toBe(true);
    expect(StepsSchema.safeParse([{ op: 'resources/nuke' }]).success).toBe(
      false
    );
  });

  it('resolves $from paths with key, index and filter segments', () => {
    const captures = {
      'tools/list': {
        tools: [
          { name: 'a', inputSchema: { type: 'object', title: 'A' } },
          { name: 'b', inputSchema: { type: 'object', title: 'B' } }
        ]
      }
    };
    expect(
      resolveFrom(captures, {
        $from: 'tools/list',
        path: 'tools[name=b].inputSchema.title'
      })
    ).toBe('B');
    expect(
      resolveFrom(captures, { $from: 'tools/list', path: 'tools[0].name' })
    ).toBe('a');
    expect(
      resolveFrom(captures, { $from: 'tools/list', path: 'tools[name=z].x' })
    ).toBeUndefined();
    expect(
      resolveArguments(captures, {
        lit: 1,
        schema: { $from: 'tools/list', path: 'tools[1].inputSchema' }
      })
    ).toEqual({ lit: 1, schema: { type: 'object', title: 'B' } });
  });

  it('every scenario that declares steps declares valid ones', () => {
    for (const name of [
      'initialize',
      'tools_call',
      'json-schema-ref-no-deref',
      'elicitation-sep1034-client-defaults'
    ]) {
      const s = getScenario(name);
      expect(s?.steps, name).toBeDefined();
      expect(StepsSchema.safeParse(s!.steps).success, name).toBe(true);
    }
  });
});
