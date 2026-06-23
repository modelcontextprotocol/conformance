import { describe, it, expect } from 'vitest';
import { AuthorizationServerOptionsSchema } from './schemas';

// Mirrors the merge logic in src/index.ts for the `authorization` command:
// CLI flags override file values; undefined CLI values must not clobber file values.
function merge(
  fileOptions: Record<string, unknown>,
  cliOptions: Record<string, unknown>
) {
  return {
    ...fileOptions,
    ...Object.fromEntries(
      Object.entries(cliOptions).filter(([, v]) => v !== undefined)
    )
  };
}

describe('authorization --file merge precedence', () => {
  it('CLI url overrides file url', () => {
    const file = { url: 'https://file.example.com' };
    const cli = { url: 'https://cli.example.com' };
    const result = AuthorizationServerOptionsSchema.parse(merge(file, cli));
    expect(result.url).toBe('https://cli.example.com');
  });

  it('file-only url passes when CLI url is undefined', () => {
    const file = { url: 'https://file.example.com' };
    const cli = { url: undefined, outputDir: undefined };
    const result = AuthorizationServerOptionsSchema.parse(merge(file, cli));
    expect(result.url).toBe('https://file.example.com');
  });

  it('missing url fails validation', () => {
    const file = {};
    const cli = { outputDir: '/tmp/out' };
    expect(() =>
      AuthorizationServerOptionsSchema.parse(merge(file, cli))
    ).toThrow();
  });

  it('strips unknown keys from file input', () => {
    const file = {
      url: 'https://file.example.com',
      __proto__: { polluted: true },
      junk: 'ignored'
    };
    const result = AuthorizationServerOptionsSchema.parse(merge(file, {}));
    expect(result).toEqual({ url: 'https://file.example.com' });
    expect(Object.keys(result)).toEqual(['url']);
  });
});
