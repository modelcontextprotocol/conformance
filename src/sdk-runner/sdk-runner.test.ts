import { describe, expect, it } from 'vitest';
import { parseSdkSpec } from './checkout';
import { lookupBuiltinConfig, KNOWN_SDKS } from './known-sdks';
import { SdkConfigSchema, resolveConfigForSpec } from './config';

describe('parseSdkSpec', () => {
  it('leaves ref undefined when omitted (resolved later via defaultRef/main)', () => {
    expect(parseSdkSpec('typescript-sdk')).toEqual({
      name: 'typescript-sdk'
    });
  });

  it('splits name@ref', () => {
    expect(parseSdkSpec('typescript-sdk@v1.29.0')).toEqual({
      name: 'typescript-sdk',
      ref: 'v1.29.0'
    });
  });

  it('handles owner/repo@ref', () => {
    expect(parseSdkSpec('someorg/some-sdk@abc123')).toEqual({
      name: 'someorg/some-sdk',
      ref: 'abc123'
    });
  });

  it('treats leading @ as part of the name', () => {
    expect(parseSdkSpec('@scope/pkg')).toEqual({
      name: '@scope/pkg'
    });
  });

  it('treats a trailing @ as no ref (falls through to defaultRef/main)', () => {
    expect(parseSdkSpec('typescript-sdk@')).toEqual({ name: 'typescript-sdk' });
  });
});

describe('SdkConfigSchema', () => {
  it('accepts a minimal client-only config', () => {
    const cfg = SdkConfigSchema.parse({
      client: { command: 'tsx fixture.ts' }
    });
    expect(cfg.client?.command).toBe('tsx fixture.ts');
    expect(cfg.server).toBeUndefined();
  });

  it('accepts an optional specVersion default', () => {
    const cfg = SdkConfigSchema.parse({
      client: { command: 'tsx fixture.ts' },
      specVersion: '2025-11-25'
    });
    expect(cfg.specVersion).toBe('2025-11-25');
  });

  it('rejects server config without a url', () => {
    expect(() =>
      SdkConfigSchema.parse({ server: { command: 'tsx server.ts' } })
    ).toThrow();
  });
});

describe('lookupBuiltinConfig', () => {
  it('finds an SDK by bare name', () => {
    expect(lookupBuiltinConfig('typescript-sdk')?.client?.command).toBeTruthy();
  });

  it('strips owner/ prefix and path segments', () => {
    expect(lookupBuiltinConfig('modelcontextprotocol/typescript-sdk')).toBe(
      KNOWN_SDKS['typescript-sdk']
    );
    expect(lookupBuiltinConfig('/some/path/to/go-sdk')).toBe(
      KNOWN_SDKS['go-sdk']
    );
  });

  it('returns null for unknown SDKs', () => {
    expect(lookupBuiltinConfig('swift-sdk')).toBeNull();
  });

  it('exposes python-sdk-v1 with repo + defaultRef + specVersion and both commands', () => {
    const py = lookupBuiltinConfig('python-sdk-v1');
    expect(py?.repo).toBe('python-sdk');
    expect(py?.defaultRef).toBe('v1.x');
    expect(py?.specVersion).toBe('2025-11-25');
    expect(py?.client?.command).toContain('client.py');
    expect(py?.server?.command).toContain('mcp-everything-server');
    expect(py?.server?.url).toBe('http://localhost:3000/mcp');
  });

  it('exposes the typescript-sdk-v1 alias with repo + defaultRef', () => {
    const v1 = lookupBuiltinConfig('typescript-sdk-v1');
    expect(v1?.repo).toBe('typescript-sdk');
    expect(v1?.defaultRef).toBe('v1.x');
  });

  it('typescript-sdk-v1 defaults to the latest dated spec version', () => {
    expect(lookupBuiltinConfig('typescript-sdk-v1')?.specVersion).toBe(
      '2025-11-25'
    );
  });

  it('bare typescript-sdk (v2) has no defaultRef or specVersion default', () => {
    expect(lookupBuiltinConfig('typescript-sdk')?.defaultRef).toBeUndefined();
    expect(lookupBuiltinConfig('typescript-sdk')?.specVersion).toBeUndefined();
  });

  it('go-sdk exposes both fixtures from conformance/ and a baseline', () => {
    const go = lookupBuiltinConfig('go-sdk');
    expect(go?.build).toContain('./conformance/everything-server');
    expect(go?.build).toContain('./conformance/everything-client');
    expect(go?.client?.command).toBe('./.conformance-client');
    expect(go?.server?.url).toBe('http://localhost:3000');
    expect(go?.expectedFailures).toBe('conformance/baseline.yml');
  });

  it('exposes python-sdk (main) with both commands and no ref/spec pin', () => {
    const py = lookupBuiltinConfig('python-sdk');
    expect(py?.repo).toBeUndefined();
    expect(py?.defaultRef).toBeUndefined();
    expect(py?.specVersion).toBeUndefined();
    expect(py?.client?.command).toContain('client.py');
    expect(py?.server?.command).toContain('mcp-everything-server');
    expect(py?.server?.url).toBe('http://localhost:3000/mcp');
  });

  it('exposes csharp-sdk with dotnet fixtures and the scenario-argv bridge', () => {
    const cs = lookupBuiltinConfig('csharp-sdk');
    expect(cs?.build).toContain('ModelContextProtocol.ConformanceClient');
    expect(cs?.build).toContain('ModelContextProtocol.ConformanceServer');
    // The C# client takes the scenario as argv[0]; the command bridges the
    // MCP_CONFORMANCE_SCENARIO env var into it.
    expect(cs?.client?.command).toContain('$MCP_CONFORMANCE_SCENARIO');
    expect(cs?.server?.url).toBe('http://localhost:3000');
  });

  it('exposes rust-sdk with the mcp-conformance fixture bins', () => {
    const rs = lookupBuiltinConfig('rust-sdk');
    expect(rs?.build).toBe('cargo build -p mcp-conformance');
    expect(rs?.client?.command).toBe('./target/debug/conformance-client');
    expect(rs?.server?.command).toContain('conformance-server');
    expect(rs?.server?.url).toBe('http://localhost:3000/mcp');
  });

  it('every built-in entry validates against SdkConfigSchema', () => {
    for (const [name, cfg] of Object.entries(KNOWN_SDKS)) {
      expect(() => SdkConfigSchema.parse(cfg), name).not.toThrow();
    }
  });
});

describe('resolveConfigForSpec', () => {
  it("rejects a 'draft' or typo'd specOverrides key at schema level", () => {
    const bad = {
      server: { command: 'x', url: 'http://localhost:3000' },
      specOverrides: { draft: { server: { command: 'y' } } }
    };
    expect(() => SdkConfigSchema.parse(bad)).toThrow(/not a spec version/);
    const typo = { ...bad, specOverrides: { '2026-7-28': {} } };
    expect(() => SdkConfigSchema.parse(typo)).toThrow(/not a spec version/);
  });

  it('returns the base config when no spec version is given', () => {
    const go = KNOWN_SDKS['go-sdk'];
    expect(resolveConfigForSpec(go, undefined)).toBe(go);
  });

  it('returns the base config for a version with no override', () => {
    const go = KNOWN_SDKS['go-sdk'];
    expect(resolveConfigForSpec(go, '2025-11-25')).toBe(go);
  });

  it('swaps the whole server command for go-sdk at 2026-07-28', () => {
    const resolved = resolveConfigForSpec(KNOWN_SDKS['go-sdk'], '2026-07-28');
    expect(resolved.server?.command).toBe(
      './.conformance-server -http=localhost:3000'
    );
    // untouched fields carry through
    expect(resolved.server?.url).toBe('http://localhost:3000');
    expect(resolved.client?.command).toBe('./.conformance-client');
    expect(resolved.expectedFailures).toBe('conformance/baseline.yml');
  });

  it('merges a partial server override (csharp url) over the base command', () => {
    const resolved = resolveConfigForSpec(
      KNOWN_SDKS['csharp-sdk'],
      '2026-07-28'
    );
    expect(resolved.server?.url).toBe('http://localhost:3000/stateless');
    expect(resolved.server?.command).toContain(
      'ModelContextProtocol.ConformanceServer.dll'
    );
  });

  it('swaps the expected-failures baseline for python-sdk at 2026-07-28', () => {
    const resolved = resolveConfigForSpec(
      KNOWN_SDKS['python-sdk'],
      '2026-07-28'
    );
    expect(resolved.expectedFailures).toBe(
      '.github/actions/conformance/expected-failures.2026-07-28.yml'
    );
    expect(resolved.server?.command).toContain('mcp-everything-server');
  });

  it('runs rust-sdk with the same default server at every revision', () => {
    // Mirrors rust-sdk's own CI, which starts one un-flagged server and runs
    // both the 2025-11-25 and 2026-07-28 legs against it. A STATELESS=1
    // override here forced the 2026 leg onto a mode that CI never exercises
    // and that fails its SEP-2575 input-required scenarios.
    for (const rev of ['2025-11-25', '2026-07-28']) {
      const resolved = resolveConfigForSpec(KNOWN_SDKS['rust-sdk'], rev);
      expect(resolved.server?.command).toBe(
        'PORT=3000 ./target/debug/conformance-server'
      );
    }
  });

  it('does not mutate the base entry', () => {
    const go = KNOWN_SDKS['go-sdk'];
    const before = JSON.stringify(go);
    resolveConfigForSpec(go, '2026-07-28');
    expect(JSON.stringify(go)).toBe(before);
  });
});
