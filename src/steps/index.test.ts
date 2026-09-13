import { describe, it, expect } from 'vitest';
import {
  StepsSchema,
  describeStep,
  resolveFrom,
  resolveArguments
} from './index';
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

  it('describes each step as one plain line', () => {
    expect(describeStep({ op: 'tools/list' })).toBe('list the tools');
    expect(
      describeStep({
        op: 'tools/call',
        name: 'add_numbers',
        arguments: { a: 5, b: 3 }
      })
    ).toBe('call add_numbers with a=5 and b=3');
    // Strings are JSON, so edge whitespace and control characters show.
    expect(
      describeStep({
        op: 'tools/call',
        name: 'x',
        arguments: { s: '\tin', crlf: 'a\r\nb', n: null, t: true, u: '世界' }
      })
    ).toBe(
      'call x with s="\\tin", crlf="a\\r\\nb", n=null, t=true and u="世界"'
    );
    expect(describeStep({ op: 'tools/call', name: 'x' })).toBe(
      'call x with no arguments'
    );
    expect(
      describeStep({
        op: 'tools/call',
        name: 'b',
        arguments: {
          schema: { $from: 'tools/list', path: 'tools[name=a].inputSchema' }
        }
      })
    ).toBe(
      'call b with schema=(tools[name=a].inputSchema from the last tools/list result)'
    );
    expect(describeStep({ op: 'wait', ms: 500 })).toBe('wait 500 ms');
    expect(describeStep({ op: 'disconnect' })).toBe('disconnect');
  });

  it('every scenario that declares steps declares valid ones', () => {
    for (const name of [
      'initialize',
      'tools_call',
      'json-schema-ref-no-deref',
      'elicitation-sep1034-client-defaults',
      'http-custom-headers',
      'http-invalid-tool-headers'
    ]) {
      const s = getScenario(name);
      expect(s?.steps, name).toBeDefined();
      expect(StepsSchema.safeParse(s!.steps).success, name).toBe(true);
    }
  });
});
