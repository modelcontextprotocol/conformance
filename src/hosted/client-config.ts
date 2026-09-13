/**
 * Ready-to-paste config for the clients people drive by hand, so adding a
 * cell's URL is one paste instead of a form per URL (VS Code's "MCP: Add
 * Server" took about eleven actions per URL, Goose's form seven). Each block
 * is the client's own file shape for a Streamable HTTP server, made to go
 * into the file a person already has:
 *
 *   VS Code      .vscode/mcp.json or the user mcp.json:
 *                { "servers": { "<name>": { "type": "http", "url": "…" } } }
 *   Codex        ~/.codex/config.toml: [mcp_servers.<name>] with url = "…";
 *                tables stand alone, so the block is appended as it is
 *   Goose        ~/.config/goose/config.yaml: entries of type
 *                streamable_http, endpoint under `uri`, indented to go under
 *                the file's own `extensions:` key (a second top-level
 *                `extensions:` is ignored without a word)
 *   Copilot CLI  ~/.copilot/mcp-config.json: mcpServers entries of type
 *                http, which also need `tools`
 *   mcpServers   the JSON many other clients read (a project .mcp.json):
 *                { "mcpServers": { "<name>": { "type": "http", … } } }
 *
 * An entry may be switched off (`enabled: false`): each auth cell starts a
 * sign-in when the client connects, so the run page lists them off. Goose
 * and Codex write that down; the JSON formats have no such field.
 *
 * Names are `c9e-<revision>-<scenario>`, lower case, with anything but
 * letters, digits, `_` and `-` made `-`: a bare TOML key for Codex, and the
 * key Goose itself would derive from the name.
 */

import { DEFAULT_COMPOSITES } from './composite';

export interface ServerEntry {
  name: string;
  url: string;
  /** False: listed but switched off, where the client can say so. */
  enabled?: boolean;
}

export type ClientKind =
  | 'vscode'
  | 'codex'
  | 'goose'
  | 'copilot'
  | 'mcpServers';

export interface ClientInfo {
  kind: ClientKind;
  label: string;
  /** Where the block goes, in a few words. */
  where: string;
  /** How to add the block to a file that already has servers in it. */
  merge: string;
  /** The format can list a server switched off. */
  switchesOff: boolean;
}

const MERGE_JSON = (key: string) =>
  `A new file takes the block as it is. In a file that already has "${key}", merge these entries into that object.`;

export const CLIENTS: readonly ClientInfo[] = [
  {
    kind: 'vscode',
    label: 'VS Code',
    where:
      '.vscode/mcp.json, or your user mcp.json (MCP: Open User Configuration)',
    merge: MERGE_JSON('servers'),
    switchesOff: false
  },
  {
    kind: 'codex',
    label: 'Codex',
    where: '~/.codex/config.toml',
    merge:
      'Open the file in an editor and paste at the end: each table stands on its own. (Pasted into cat >> in a terminal, the end of the paste can be lost.)',
    switchesOff: true
  },
  {
    kind: 'goose',
    label: 'Goose',
    where: '~/.config/goose/config.yaml',
    merge: 'Paste under extensions: in ~/.config/goose/config.yaml.',
    switchesOff: true
  },
  {
    kind: 'copilot',
    label: 'Copilot CLI',
    where: '~/.copilot/mcp-config.json',
    merge: `${MERGE_JSON('mcpServers')} Switch one off with /mcp disable <name>.`,
    switchesOff: false
  },
  {
    kind: 'mcpServers',
    label: 'mcpServers JSON',
    where: 'a project .mcp.json, or any client that reads mcpServers',
    merge: MERGE_JSON('mcpServers'),
    switchesOff: false
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

/** A string any of the formats reads back unchanged. */
const quoted = (s: string) => JSON.stringify(s);

const jsonBlock = (
  key: string,
  entries: readonly ServerEntry[],
  entry: (e: ServerEntry) => Record<string, unknown>
) =>
  JSON.stringify(
    { [key]: Object.fromEntries(entries.map((e) => [e.name, entry(e)])) },
    null,
    2
  );

export function clientConfig(
  kind: ClientKind,
  entries: readonly ServerEntry[]
): string {
  switch (kind) {
    case 'vscode':
      return jsonBlock('servers', entries, (e) => ({
        type: 'http',
        url: e.url
      }));
    case 'mcpServers':
      return jsonBlock('mcpServers', entries, (e) => ({
        type: 'http',
        url: e.url
      }));
    case 'copilot':
      return jsonBlock('mcpServers', entries, (e) => ({
        type: 'http',
        url: e.url,
        tools: ['*']
      }));
    case 'codex':
      return entries
        .map((e) =>
          [
            `[mcp_servers.${e.name}]`,
            `url = ${quoted(e.url)}`,
            ...(e.enabled === false ? ['enabled = false'] : [])
          ].join('\n')
        )
        .join('\n\n');
    case 'goose':
      return entries
        .map((e) =>
          [
            `  ${e.name}:`,
            `    enabled: ${e.enabled !== false}`,
            '    type: streamable_http',
            `    name: ${e.name}`,
            `    uri: ${quoted(e.url)}`,
            '    timeout: 300'
          ].join('\n')
        )
        .join('\n');
  }
}
