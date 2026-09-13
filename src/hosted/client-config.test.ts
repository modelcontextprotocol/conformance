import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  clientConfig,
  compositeName,
  serverName,
  type ServerEntry
} from './client-config';
import { DEFAULT_COMPOSITES } from './composite';

const entries: ServerEntry[] = [
  {
    name: serverName('2025-11-25', 'auth/metadata-default'),
    url: 'https://h.example/s/run/2025-11-25/auth/metadata-default/mcp'
  },
  {
    name: serverName('2026-07-28', 'tools_call'),
    url: 'https://h.example/s/run/2026-07-28/tools_call/mcp'
  }
];

/** What Goose derives a config key from an extension's name. */
const gooseKey = (name: string) =>
  name
    .split('')
    .filter((c) => !/\s/.test(c))
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : '_'))
    .join('')
    .toLowerCase();

describe('client config names', () => {
  it('are valid in every format: a bare TOML key, the key Goose derives', () => {
    for (const name of [
      serverName('2025-11-25', 'auth/metadata-default'),
      serverName('2026-07-28', 'sep-2322-client-request-state'),
      compositeName('2026-07-28', DEFAULT_COMPOSITES['2026-07-28']),
      compositeName('2025-11-25', ['initialize', 'tools_call']),
      compositeName('2026-07-28', ['tools_call', 'http-standard-headers'])
    ]) {
      expect(name).toMatch(/^c9e-[a-z0-9_-]+$/);
      expect(gooseKey(name)).toBe(name);
    }
    expect(serverName('2025-11-25', 'auth/metadata-default')).toBe(
      'c9e-2025-11-25-auth-metadata-default'
    );
    expect(compositeName('2026-07-28', DEFAULT_COMPOSITES['2026-07-28'])).toBe(
      'c9e-2026-07-28-composite'
    );
    expect(
      compositeName('2026-07-28', ['tools_call', 'http-standard-headers'])
    ).toBe('c9e-2026-07-28-tools_call-http-standard-headers');
  });
});

describe('client config blocks', () => {
  it('VS Code: servers with type http', () => {
    expect(JSON.parse(clientConfig('vscode', entries))).toEqual({
      servers: {
        'c9e-2025-11-25-auth-metadata-default': {
          type: 'http',
          url: entries[0].url
        },
        'c9e-2026-07-28-tools_call': { type: 'http', url: entries[1].url }
      }
    });
  });

  it('Codex: an [mcp_servers.<name>] table with url', () => {
    expect(clientConfig('codex', entries)).toBe(
      [
        '[mcp_servers.c9e-2025-11-25-auth-metadata-default]',
        `url = "${entries[0].url}"`,
        '',
        '[mcp_servers.c9e-2026-07-28-tools_call]',
        `url = "${entries[1].url}"`
      ].join('\n')
    );
  });

  it('Goose: streamable_http extensions with uri', () => {
    expect(parseYaml(clientConfig('goose', entries))).toEqual({
      extensions: {
        'c9e-2025-11-25-auth-metadata-default': {
          enabled: true,
          type: 'streamable_http',
          name: 'c9e-2025-11-25-auth-metadata-default',
          uri: entries[0].url,
          timeout: 300
        },
        'c9e-2026-07-28-tools_call': {
          enabled: true,
          type: 'streamable_http',
          name: 'c9e-2026-07-28-tools_call',
          uri: entries[1].url,
          timeout: 300
        }
      }
    });
  });

  it('mcpServers: the shape most other clients read', () => {
    expect(JSON.parse(clientConfig('mcpServers', entries.slice(1)))).toEqual({
      mcpServers: {
        'c9e-2026-07-28-tools_call': { type: 'http', url: entries[1].url }
      }
    });
  });
});
