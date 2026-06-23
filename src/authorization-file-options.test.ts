import { describe, it, expect } from 'vitest';
import { AuthorizationServerOptionsSchema } from './schemas';

// Mirrors the merge logic in src/index.ts for the `authorization` command:
// the file is validated standalone via .strict(), then CLI flags override.
// Undefined CLI values must not clobber file values.
const FileSchema = AuthorizationServerOptionsSchema.strict();

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

describe('authorization --file validation', () => {
  it('accepts a complete file', () => {
    const result = FileSchema.parse({ url: 'https://file.example.com' });
    expect(result.url).toBe('https://file.example.com');
  });

  it('rejects a file missing required url (even if --url would be supplied)', () => {
    expect(() => FileSchema.parse({})).toThrow();
  });

  it('rejects unknown keys (catches typos)', () => {
    expect(() =>
      FileSchema.parse({ url: 'https://file.example.com', urll: 'typo' })
    ).toThrow();
  });

  it('rejects an invalid url value', () => {
    expect(() => FileSchema.parse({ url: 'not-a-url' })).toThrow();
  });
});

describe('authorization --file merge precedence', () => {
  it('CLI url overrides file url', () => {
    const file = FileSchema.parse({ url: 'https://file.example.com' });
    const cli = { url: 'https://cli.example.com' };
    const result = AuthorizationServerOptionsSchema.parse(merge(file, cli));
    expect(result.url).toBe('https://cli.example.com');
  });

  it('file-only url passes when CLI url is undefined', () => {
    const file = FileSchema.parse({ url: 'https://file.example.com' });
    const cli = { url: undefined, outputDir: undefined };
    const result = AuthorizationServerOptionsSchema.parse(merge(file, cli));
    expect(result.url).toBe('https://file.example.com');
  });
});
