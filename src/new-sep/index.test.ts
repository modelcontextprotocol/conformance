import { describe, it, expect } from 'vitest';
import { specPathToUrl, inferTarget, renderYaml } from './index';

describe('specPathToUrl', () => {
  it('strips the docs/specification/draft/ prefix and .mdx suffix', () => {
    expect(specPathToUrl('docs/specification/draft/server/resources.mdx')).toBe(
      'https://modelcontextprotocol.io/specification/draft/server/resources'
    );
  });

  it('handles nested paths', () => {
    expect(specPathToUrl('docs/specification/draft/basic/lifecycle.mdx')).toBe(
      'https://modelcontextprotocol.io/specification/draft/basic/lifecycle'
    );
  });

  it('rejects paths outside docs/specification/draft/', () => {
    expect(() =>
      specPathToUrl('docs/specification/2025-11-25/server/x.mdx')
    ).toThrow(/must start with/);
  });
});

describe('inferTarget', () => {
  it('returns server for server/ paths', () => {
    expect(
      inferTarget('docs/specification/draft/server/resources.mdx')
    ).toEqual({ target: 'server', inferred: false });
  });

  it('returns client for client/ paths', () => {
    expect(inferTarget('docs/specification/draft/client/sampling.mdx')).toEqual(
      { target: 'client', inferred: false }
    );
  });

  it('returns authorization-server for basic/authorization* paths', () => {
    expect(
      inferTarget('docs/specification/draft/basic/authorization.mdx')
    ).toEqual({ target: 'authorization-server', inferred: false });
  });

  it('falls back to server (inferred) for unrecognized paths', () => {
    expect(inferTarget('docs/specification/draft/basic/lifecycle.mdx')).toEqual(
      { target: 'server', inferred: true }
    );
  });

  it('accepts paths already stripped of the prefix', () => {
    expect(inferTarget('client/elicitation.mdx')).toEqual({
      target: 'client',
      inferred: false
    });
  });
});

describe('renderYaml', () => {
  it('emits placeholder yaml in the sep-2164.yaml style', () => {
    const out = renderYaml({
      sep: 9999,
      specUrl:
        'https://modelcontextprotocol.io/specification/draft/server/resources'
    });
    expect(out).toBe(
      `sep: 9999
spec_url: https://modelcontextprotocol.io/specification/draft/server/resources
requirements:
  - text: 'TODO: quote the normative sentence from the spec diff'
    check: sep-9999-todo
  - text: 'TODO: requirement that cannot be tested'
    excluded: 'TODO: reason'
    issue: https://github.com/modelcontextprotocol/conformance/issues/<NNNN>
`
    );
  });

  it('matches the byte-shape of the real sep-2164.yaml when given its rows', () => {
    const out = renderYaml({
      sep: 2164,
      specUrl:
        'https://modelcontextprotocol.io/specification/draft/server/resources#error-handling',
      requirements: [
        {
          text: 'Servers MUST NOT return an empty contents array for a non-existent resource',
          check: 'sep-2164-no-empty-contents'
        },
        {
          text: 'Servers SHOULD return standard JSON-RPC errors for common failure cases: Resource not found: -32602 (Invalid Params)',
          check: 'sep-2164-error-code'
        },
        {
          text: 'clients SHOULD also accept -32002 as a resource not found error',
          excluded:
            'Client-side error handling is implementation-defined; not protocol-observable'
        }
      ]
    });
    expect(out).toBe(
      `sep: 2164
spec_url: https://modelcontextprotocol.io/specification/draft/server/resources#error-handling
requirements:
  - text: 'Servers MUST NOT return an empty contents array for a non-existent resource'
    check: sep-2164-no-empty-contents
  - text: 'Servers SHOULD return standard JSON-RPC errors for common failure cases: Resource not found: -32602 (Invalid Params)'
    check: sep-2164-error-code
  - text: 'clients SHOULD also accept -32002 as a resource not found error'
    excluded: 'Client-side error handling is implementation-defined; not protocol-observable'
`
    );
  });

  it('escapes single quotes by doubling them', () => {
    const out = renderYaml({
      sep: 1,
      specUrl: 'https://example.com/x',
      requirements: [{ text: "can't happen", check: 'sep-1-x' }]
    });
    expect(out).toContain("text: 'can''t happen'");
  });
});
