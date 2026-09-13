/**
 * Ready-to-paste config for the clients people drive by hand, so adding a
 * cell's URL is one paste instead of a form per URL (VS Code's "MCP: Add
 * Server" took about eleven actions per URL, Goose's form seven). Each block
 * is the client's own file shape for a Streamable HTTP server:
 *
 *   VS Code  .vscode/mcp.json or the user mcp.json:
 *            { "servers": { "<name>": { "type": "http", "url": "…" } } }
 *   Codex    ~/.codex/config.toml: [mcp_servers.<name>] with url = "…"
 *   Goose    ~/.config/goose/config.yaml: an `extensions:` entry of
 *            type streamable_http, its endpoint under `uri`
 *   mcpServers  the JSON many other clients read (a project .mcp.json):
 *            { "mcpServers": { "<name>": { "type": "http", … } } }
 *
 * Names are `c9e-<revision>-<scenario>`, lower case, with anything but
 * letters, digits, `_` and `-` made `-`: a bare TOML key for Codex, and the
 * key Goose itself would derive from the name.
 */

import { DEFAULT_COMPOSITES } from './composite';

export interface ServerEntry {
  name: string;
  url: string;
}

export type ClientKind = 'vscode' | 'codex' | 'goose' | 'mcpServers';

export interface ClientInfo {
  kind: ClientKind;
  label: string;
  /** Where the block goes, in a few words. */
  where: string;
}

export const CLIENTS: readonly ClientInfo[] = [
  {
    kind: 'vscode',
    label: 'VS Code',
    where:
      '.vscode/mcp.json, or your user mcp.json (MCP: Open User Configuration)'
  },
  { kind: 'codex', label: 'Codex', where: '~/.codex/config.toml' },
  { kind: 'goose', label: 'Goose', where: '~/.config/goose/config.yaml' },
  {
    kind: 'mcpServers',
    label: 'mcpServers JSON',
    where: 'a project .mcp.json, or any client that reads mcpServers'
  }
];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/** `c9e-<revision>-<scenario>`, valid as a name in every block. */
export function serverName(revision: string, scenario: string): string {
  return `c9e-${slug(revision)}-${slug(scenario)}`;
}

/**
 * A composite's name: `c9e-<revision>-composite` for the run page's
 * ready-made one, otherwise its children's names joined.
 */
export function compositeName(
  revision: string,
  children: readonly string[]
): string {
  const ready = DEFAULT_COMPOSITES[revision] ?? [];
  const isReady =
    ready.length === children.length &&
    ready.every((name, i) => name === children[i]);
  return serverName(revision, isReady ? 'composite' : children.join('-'));
}

/** A string any of the three formats reads back unchanged. */
const quoted = (s: string) => JSON.stringify(s);

export function clientConfig(
  kind: ClientKind,
  entries: readonly ServerEntry[]
): string {
  switch (kind) {
    case 'vscode':
      return JSON.stringify(
        {
          servers: Object.fromEntries(
            entries.map((e) => [e.name, { type: 'http', url: e.url }])
          )
        },
        null,
        2
      );
    case 'mcpServers':
      return JSON.stringify(
        {
          mcpServers: Object.fromEntries(
            entries.map((e) => [e.name, { type: 'http', url: e.url }])
          )
        },
        null,
        2
      );
    case 'codex':
      return entries
        .map((e) => `[mcp_servers.${e.name}]\nurl = ${quoted(e.url)}`)
        .join('\n\n');
    case 'goose':
      return [
        'extensions:',
        ...entries.map((e) =>
          [
            `  ${e.name}:`,
            '    enabled: true',
            '    type: streamable_http',
            `    name: ${e.name}`,
            `    uri: ${quoted(e.url)}`,
            '    timeout: 300'
          ].join('\n')
        )
      ].join('\n');
  }
}
