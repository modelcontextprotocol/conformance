import { describe, expect, it } from 'vitest';
import { parseSdkSpec } from './checkout';
import { SdkConfigSchema } from './config';
import { lookupBuiltinConfig, KNOWN_SDKS } from './known-sdks';

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
    expect(lookupBuiltinConfig('rust-sdk')).toBeNull();
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

  it('exposes go-sdk with both fixture commands and the repo baseline', () => {
    const go = lookupBuiltinConfig('go-sdk');
    expect(go?.build).toContain('./conformance/everything-client');
    expect(go?.build).toContain('./conformance/everything-server');
    expect(go?.client?.command).toBe('./.conformance-client');
    expect(go?.server?.url).toBe('http://localhost:3000/mcp');
    expect(go?.expectedFailures).toBe('conformance/baseline.yml');
  });

  it('exposes csharp-sdk as client-only, forwarding scenario and URL', () => {
    const cs = lookupBuiltinConfig('csharp-sdk');
    expect(cs?.build).toContain('ModelContextProtocol.ConformanceClient');
    // The fixture wants <scenario> <url> as positional args; the sh -c shim
    // maps the env var and the runner-appended URL onto them.
    expect(cs?.client?.command).toContain('"$MCP_CONFORMANCE_SCENARIO" "$1"');
    expect(cs?.server).toBeUndefined();
  });

  it('every built-in entry validates against SdkConfigSchema', () => {
    for (const [name, cfg] of Object.entries(KNOWN_SDKS)) {
      expect(() => SdkConfigSchema.parse(cfg), name).not.toThrow();
    }
  });
});
