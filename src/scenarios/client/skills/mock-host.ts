/**
 * A configurable SEP-2640 server for the client scenarios that grade what a
 * host does with a listing: what it loads, what it refuses, and which server
 * it reads from. It serves a fixed catalogue and records every request, and
 * the scenarios grade that log.
 *
 * One scenario can run two of these. `start()` returns one `serverUrl` per
 * instance, and a scenario hands the second one to the client in
 * `ScenarioUrls.context`, the way the auth scenarios hand over their
 * authorization server.
 */

import { createHash } from 'crypto';
import http from 'http';
import type { ConformanceCheck } from '../../../types.js';
import { BaseHttpScenario } from '../http-base.js';
import {
  initializeResult,
  readResult,
  skillsListResult
} from './mock-results.js';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

const JSONRPC_INVALID_PARAMS = -32602;

export const sha256 = (s: string) =>
  'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

/** A SKILL.md with the frontmatter an entry for it must carry. */
export function skillMd(name: string, body = 'Skill body.'): string {
  return `---\nname: ${name}\ndescription: The ${name} fixture skill\n---\n\n${body}\n`;
}

/**
 * An honest entry: `resources` lists every file in `files` with its real
 * digest and size, and `frontmatter` matches the SKILL.md at `uri`.
 */
export function entryFor(
  uri: string,
  name: string,
  files: Record<string, string>
): Record<string, unknown> {
  return {
    uri,
    frontmatter: { name, description: `The ${name} fixture skill` },
    resources: Object.entries(files).map(([u, text]) => ({
      uri: u,
      digest: sha256(text),
      size: Buffer.byteLength(text)
    }))
  };
}

export interface MockHostConfig {
  /** What `skills/list` answers. */
  listed: object[];
  /** What `skills/get` resolves, by `uri`. Defaults to `listed`. */
  gettable?: object[];
  /** Every file `resources/read` serves, by URI. */
  files: Record<string, string>;
  /** Directory URI to its children. Declares `directoryRead` when present. */
  dirs?: Record<string, object[]>;
}

export interface LoggedRequest {
  method: string;
  uri?: string;
}

export class SkillsMockHost extends BaseHttpScenario {
  name: string;
  description = 'A SEP-2640 server that records what the client asks for.';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  readonly requests: LoggedRequest[] = [];

  constructor(
    name: string,
    private readonly config: MockHostConfig
  ) {
    super();
    this.name = name;
  }

  /** Every `resources/read` URI, in order. */
  reads(): string[] {
    return this.requests
      .filter((r) => r.method === 'resources/read' && r.uri !== undefined)
      .map((r) => r.uri!);
  }

  called(method: string, uri?: string): boolean {
    return this.requests.some(
      (r) => r.method === method && (uri === undefined || r.uri === uri)
    );
  }

  getChecks(): ConformanceCheck[] {
    return [];
  }

  protected discoverCapabilities(): object {
    const settings = this.config.dirs ? { directoryRead: true } : {};
    return {
      resources: { listChanged: false },
      extensions: { [SKILLS_EXTENSION_ID]: settings }
    };
  }

  protected handlePost(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    const method = request.method as string;
    const uri =
      typeof request.params?.uri === 'string' ? request.params.uri : undefined;
    if (request.id !== undefined) this.requests.push({ method, uri });
    const reply = (result: unknown) =>
      this.sendJson(res, { jsonrpc: '2.0', id: request.id, result });
    const invalid = (message: string) =>
      this.sendJson(res, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: JSONRPC_INVALID_PARAMS, message }
      });

    switch (method) {
      case 'initialize':
        reply(
          initializeResult(this.name, request, this.discoverCapabilities())
        );
        return;
      case 'skills/list':
        reply(skillsListResult(this.config.listed));
        return;
      case 'skills/get': {
        const pool = (this.config.gettable ?? this.config.listed) as Array<{
          uri?: unknown;
        }>;
        const skill = pool.find((e) => e.uri === uri);
        if (!skill) return invalid(`no skill at ${uri}`);
        reply({
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          skill
        });
        return;
      }
      case 'resources/read': {
        const text = uri !== undefined ? this.config.files[uri] : undefined;
        if (text === undefined) return invalid(`${uri} is not served here`);
        reply(readResult(uri, text));
        return;
      }
      case 'resources/directory/read': {
        const children =
          uri !== undefined ? this.config.dirs?.[uri] : undefined;
        if (!children) return invalid(`${uri} is not a directory`);
        reply({
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          resources: children
        });
        return;
      }
      default:
        if (request.id === undefined) {
          this.sendNotificationAck(res);
          return;
        }
        this.sendGenericResult(res, request);
    }
  }
}
