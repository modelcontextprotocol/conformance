import { describe, expect, test } from 'vitest';
import {
  encodeHeaderValue,
  paramHeaders,
  standardHeaders,
  toolHeaderParams
} from './mcpHeaders';

describe('encodeHeaderValue', () => {
  // The encoding examples table in the 2026-07-28 streamable-http transport.
  test.each([
    ['us-west1', 'us-west1'],
    ['Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
    [' padded ', '=?base64?IHBhZGRlZCA=?='],
    ['line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
    ['=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=']
  ])('encodes %j as the spec shows', (value, header) => {
    expect(encodeHeaderValue(value)).toBe(header);
  });

  test('keeps inner spaces and the empty string plain', () => {
    expect(encodeHeaderValue('us west 1')).toBe('us west 1');
    expect(encodeHeaderValue('')).toBe('');
  });

  test('encodes tabs and carriage returns', () => {
    for (const value of ['\tindented', 'a\tb', 'line1\r\nline2']) {
      expect(encodeHeaderValue(value)).toBe(
        `=?base64?${Buffer.from(value).toString('base64')}?=`
      );
    }
  });
});

describe('standardHeaders', () => {
  test('sends Mcp-Method on every method and Mcp-Name where one applies', () => {
    expect(standardHeaders({ method: 'tools/list' })).toEqual({
      'Mcp-Method': 'tools/list'
    });
    expect(
      standardHeaders({ method: 'tools/call', params: { name: 'my-tool' } })
    ).toEqual({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'my-tool' });
    expect(
      standardHeaders({
        method: 'resources/read',
        params: { uri: 'file:///a%20b.txt' }
      })
    ).toEqual({
      'Mcp-Method': 'resources/read',
      'Mcp-Name': 'file:///a%20b.txt'
    });
    expect(
      standardHeaders({ method: 'prompts/get', params: { name: 'Grüße' } })
    ).toEqual({
      'Mcp-Method': 'prompts/get',
      'Mcp-Name': encodeHeaderValue('Grüße')
    });
  });

  test('gives a method named like an Object member no Mcp-Name', () => {
    expect(
      standardHeaders({ method: 'constructor', params: { name: 'x' } })
    ).toEqual({ 'Mcp-Method': 'constructor' });
  });
});

describe('toolHeaderParams', () => {
  const schema = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties
  });

  test('collects annotations along properties chains, nested ones included', () => {
    const verdict = toolHeaderParams(
      schema({
        region: { type: 'string', 'x-mcp-header': 'Region' },
        query: { type: 'string' },
        target: {
          type: 'object',
          properties: { zone: { type: 'integer', 'x-mcp-header': 'Zone' } }
        }
      })
    );
    expect(verdict).toEqual({
      ok: true,
      params: [
        { path: ['region'], header: 'Region' },
        { path: ['target', 'zone'], header: 'Zone' }
      ]
    });
  });

  test('ignores x-mcp-header keys inside instance data', () => {
    expect(
      toolHeaderParams(
        schema({
          blob: { type: 'object', default: { 'x-mcp-header': 'NotOne' } }
        })
      )
    ).toEqual({ ok: true, params: [] });
  });

  // The invalid tools http-invalid-tool-headers serves, plus placements the
  // spec rules out.
  test.each([
    ['empty', schema({ v: { type: 'string', 'x-mcp-header': '' } })],
    ['object', schema({ v: { type: 'object', 'x-mcp-header': 'Data' } })],
    ['array', schema({ v: { type: 'array', 'x-mcp-header': 'Items' } })],
    ['null', schema({ v: { type: 'null', 'x-mcp-header': 'Nil' } })],
    ['number', schema({ v: { type: 'number', 'x-mcp-header': 'Score' } })],
    [
      'duplicate',
      schema({
        a: { type: 'string', 'x-mcp-header': 'Region' },
        b: { type: 'string', 'x-mcp-header': 'Region' }
      })
    ],
    [
      'duplicate in another case',
      schema({
        a: { type: 'string', 'x-mcp-header': 'MyField' },
        b: { type: 'string', 'x-mcp-header': 'myfield' }
      })
    ],
    ['space', schema({ v: { type: 'string', 'x-mcp-header': 'My Region' } })],
    ['colon', schema({ v: { type: 'string', 'x-mcp-header': 'Region:A' } })],
    ['non-ASCII', schema({ v: { type: 'string', 'x-mcp-header': 'Région' } })],
    ['tab', schema({ v: { type: 'string', 'x-mcp-header': 'Region\t1' } })],
    ['not a string', schema({ v: { type: 'string', 'x-mcp-header': 7 } })],
    ['untyped', schema({ v: { 'x-mcp-header': 'V' } })],
    ['on the root', { type: 'object', 'x-mcp-header': 'Root' }],
    [
      'under items',
      schema({
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: { v: { type: 'string', 'x-mcp-header': 'V' } }
          }
        }
      })
    ],
    [
      'under oneOf',
      {
        oneOf: [schema({ v: { type: 'string', 'x-mcp-header': 'V' } })]
      }
    ],
    [
      'under $defs',
      {
        ...schema({ v: { $ref: '#/$defs/v' } }),
        $defs: { v: { type: 'string', 'x-mcp-header': 'V' } }
      }
    ]
  ])('rejects an annotation that is %s', (_label, inputSchema) => {
    const verdict = toolHeaderParams(inputSchema);
    expect(verdict.ok).toBe(false);
  });
});

describe('paramHeaders', () => {
  const params = [
    { path: ['region'], header: 'Region' },
    { path: ['priority'], header: 'Priority' },
    { path: ['verbose'], header: 'Verbose' },
    { path: ['target', 'zone'], header: 'Zone' },
    { path: ['greeting'], header: 'Greeting' }
  ];

  test('converts, encodes and omits as SEP-2243 says', () => {
    expect(
      paramHeaders(params, {
        region: 'us-west1',
        priority: 42,
        verbose: false,
        target: { zone: 'a' },
        greeting: 'Hello, 世界'
      })
    ).toEqual({
      'Mcp-Param-Region': 'us-west1',
      'Mcp-Param-Priority': '42',
      'Mcp-Param-Verbose': 'false',
      'Mcp-Param-Zone': 'a',
      'Mcp-Param-Greeting': '=?base64?SGVsbG8sIOS4lueVjA==?='
    });
  });

  test('sends nothing for a null or missing value', () => {
    expect(
      paramHeaders(params, { region: 'us-east1', verbose: null, target: {} })
    ).toEqual({ 'Mcp-Param-Region': 'us-east1' });
    expect(paramHeaders(params, undefined)).toEqual({});
  });
});
