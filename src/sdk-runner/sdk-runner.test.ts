import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parseSdkSpec } from './checkout';
import { loadSdkConfig, SdkConfigSchema } from './config';
import { lookupBuiltinConfig, KNOWN_SDKS } from './known-sdks';

describe('parseSdkSpec', () => {
  it('defaults ref to main when omitted', () => {
    expect(parseSdkSpec('typescript-sdk')).toEqual({
      name: 'typescript-sdk',
      ref: 'main'
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
      name: '@scope/pkg',
      ref: 'main'
    });
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

  it('rejects server config without a url', () => {
    expect(() =>
      SdkConfigSchema.parse({ server: { command: 'tsx server.ts' } })
    ).toThrow();
  });
});

describe('loadSdkConfig', () => {
  it('loads conformance.config.yaml from a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-cfg-'));
    try {
      await fs.writeFile(
        path.join(dir, 'conformance.config.yaml'),
        [
          'build: npm ci && npm run build',
          'client:',
          '  command: tsx test/client.ts',
          'server:',
          '  command: tsx test/server.ts',
          '  url: http://localhost:3000/mcp',
          'expectedFailures: baseline.yml'
        ].join('\n')
      );
      const cfg = await loadSdkConfig(dir);
      expect(cfg).toEqual({
        build: 'npm ci && npm run build',
        client: { command: 'tsx test/client.ts' },
        server: {
          command: 'tsx test/server.ts',
          url: 'http://localhost:3000/mcp'
        },
        expectedFailures: 'baseline.yml'
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no config file is present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-cfg-'));
    try {
      expect(await loadSdkConfig(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  it('every built-in entry validates against SdkConfigSchema', () => {
    for (const [name, cfg] of Object.entries(KNOWN_SDKS)) {
      expect(() => SdkConfigSchema.parse(cfg), name).not.toThrow();
    }
  });
});
