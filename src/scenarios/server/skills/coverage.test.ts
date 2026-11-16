import { describe, test, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { withRequiredDraftResultFields } from '../../../mock-server';
import { takeWireViolations } from '../../../validation/wire-schema';
import { SkillsEnumerationScenario } from './enumeration';
import { SkillsDirectoryReadScenario } from './directory';
import { SKILLS_EXTENSION_ID } from './helpers';

/**
 * Positive and negative controls for the nested-skill, error-handling and
 * directory checks. The fixture gets every rule right: acme encloses billing
 * and lists billing's SKILL.md, an unserved file answers -32602 with a reason,
 * and the acme directory holds an empty subdirectory. Each negative test
 * breaks one rule and asserts that the matching check fails.
 */

const DIR = 'inode/directory';
const ZERO = `sha256:${'0'.repeat(64)}`;
const OUTER = 'skill://acme/SKILL.md';
const INNER = 'skill://acme/billing/SKILL.md';

interface Fixture {
  skills: object[];
  /** Directory URI to its children, or 'omit' to answer with no resources member. */
  dirs: Record<string, object[] | 'omit'>;
  /** The error resources/read answers for a file the server does not serve. */
  unserved: { code: number; message: string } | 'succeed';
  dirCache: boolean;
}

function goodFixture(): Fixture {
  return {
    skills: [
      {
        uri: OUTER,
        frontmatter: { name: 'acme', description: 'The enclosing skill.' },
        resources: [
          { uri: OUTER, digest: ZERO, size: 1 },
          { uri: INNER, digest: ZERO, size: 1 }
        ]
      },
      {
        uri: INNER,
        frontmatter: { name: 'billing', description: 'A nested skill.' },
        resources: [{ uri: INNER, digest: ZERO, size: 1 }]
      }
    ],
    dirs: {
      'skill://acme': [
        { uri: OUTER, name: 'SKILL.md', mimeType: 'text/markdown' },
        { uri: 'skill://acme/billing', name: 'billing', mimeType: DIR },
        { uri: 'skill://acme/empty', name: 'empty', mimeType: DIR }
      ],
      'skill://acme/billing': [
        { uri: INNER, name: 'SKILL.md', mimeType: 'text/markdown' }
      ],
      'skill://acme/empty': []
    },
    unserved: { code: -32602, message: 'skill://acme has no file named that' },
    dirCache: true
  };
}

async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function startServer(f: Fixture): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readJsonBody(req);
    const method = body.method as string;
    const id = body.id;
    const uri = (body.params as { uri?: string } | undefined)?.uri;
    const send = (result: object) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: withRequiredDraftResultFields(method, result)
        })
      );
    };
    const fail = (code: number, message: string) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };

    switch (method) {
      case 'server/discover':
        send({
          supportedVersions: [DRAFT_PROTOCOL_VERSION],
          capabilities: {
            resources: {},
            extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } }
          },
          serverInfo: { name: 'skills-coverage', version: '1.0.0' }
        });
        return;
      case 'skills/list':
        send({ skills: f.skills, ttlMs: 0, cacheScope: 'private' });
        return;
      case 'skills/get': {
        const skill = (f.skills as Array<{ uri: string }>).find(
          (s) => s.uri === uri
        );
        if (!skill) return fail(-32602, `no skill at ${uri}`);
        send({ skill, ttlMs: 0, cacheScope: 'private' });
        return;
      }
      case 'resources/list':
        send({ resources: [] });
        return;
      case 'resources/read':
        if (uri === OUTER || uri === INNER) {
          const name = uri === OUTER ? 'acme' : 'billing';
          send({
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: `---\nname: ${name}\ndescription: x\n---\n`
              }
            ]
          });
          return;
        }
        if (f.unserved === 'succeed') {
          send({ contents: [{ uri, mimeType: 'text/markdown', text: 'x' }] });
          return;
        }
        return fail(f.unserved.code, f.unserved.message);
      case 'resources/directory/read': {
        const children = uri !== undefined ? f.dirs[uri] : undefined;
        if (children === undefined)
          return fail(-32602, `${uri} is not a directory`);
        const cache = f.dirCache ? { ttlMs: 0, cacheScope: 'private' } : {};
        send(children === 'omit' ? cache : { resources: children, ...cache });
        return;
      }
    }
    fail(-32601, `Method not found: ${method}`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://localhost:${addr.port}/mcp`, server });
    });
  });
}

async function checksFor(f: Fixture) {
  const { url, server } = await startServer(f);
  try {
    const ctx = () => testContext(url, DRAFT_PROTOCOL_VERSION);
    const checks = [
      ...(await new SkillsEnumerationScenario().run(ctx())),
      ...(await new SkillsDirectoryReadScenario().run(ctx()))
    ];
    // Broken fixtures may break the base schema too; these tests assert the
    // scenarios' own checks.
    takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const statusOf = async (f: Fixture, id: string) =>
  (await checksFor(f)).get(id)?.status;

const NEW_IDS = [
  'sep-2640-resources-nested-completeness',
  'sep-2640-nested-publication-flat',
  'sep-2640-error-standard-codes',
  'sep-2640-error-informative-messages',
  'sep-2640-directory-read-cache-attributes',
  'sep-2640-directory-read-empty-dir'
];

describe('SEP-2640 nested skills, errors and directory coverage', () => {
  test('a server that gets every rule right passes every new check', async () => {
    const checks = await checksFor(goodFixture());
    const notPassing = NEW_IDS.map((id) => checks.get(id))
      .filter((c) => c?.status !== 'SUCCESS')
      .map((c) => `${c?.id}: ${c?.status} ${c?.errorMessage ?? ''}`);
    expect(notPassing).toEqual([]);
  });

  test('an enclosing skill that leaves out the nested SKILL.md fails nested-completeness', async () => {
    const f = goodFixture();
    (f.skills[0] as { resources: object[] }).resources = [
      { uri: OUTER, digest: ZERO, size: 1 }
    ];
    expect(await statusOf(f, 'sep-2640-resources-nested-completeness')).toBe(
      'FAILURE'
    );
  });

  test('an entry that embeds the nested entry fails nested-publication-flat', async () => {
    const f = goodFixture();
    f.skills[0] = { ...f.skills[0], children: [f.skills[1]] };
    expect(await statusOf(f, 'sep-2640-nested-publication-flat')).toBe(
      'FAILURE'
    );
  });

  test('a listing with no nested skill SKIPs both nesting checks', async () => {
    const f = goodFixture();
    f.skills = [f.skills[0]];
    const checks = await checksFor(f);
    expect(checks.get('sep-2640-resources-nested-completeness')?.status).toBe(
      'SKIPPED'
    );
    expect(checks.get('sep-2640-nested-publication-flat')?.status).toBe(
      'SKIPPED'
    );
  });

  test('-32002 for an unserved file fails error-standard-codes on 2026-07-28', async () => {
    const f = goodFixture();
    f.unserved = { code: -32002, message: 'no such resource' };
    expect(await statusOf(f, 'sep-2640-error-standard-codes')).toBe('FAILURE');
  });

  test('serving a file the skill does not list fails error-standard-codes', async () => {
    expect(
      await statusOf(
        { ...goodFixture(), unserved: 'succeed' },
        'sep-2640-error-standard-codes'
      )
    ).toBe('FAILURE');
  });

  test('an error message that only names the code is a WARNING', async () => {
    const f = goodFixture();
    f.unserved = { code: -32602, message: 'Invalid params' };
    expect(await statusOf(f, 'sep-2640-error-informative-messages')).toBe(
      'WARNING'
    );
  });

  test('a directory read without ttlMs and cacheScope fails directory-read-cache-attributes', async () => {
    expect(
      await statusOf(
        { ...goodFixture(), dirCache: false },
        'sep-2640-directory-read-cache-attributes'
      )
    ).toBe('FAILURE');
  });

  test('an empty directory answered with no resources member fails directory-read-empty-dir', async () => {
    const f = goodFixture();
    f.dirs['skill://acme/empty'] = 'omit';
    expect(await statusOf(f, 'sep-2640-directory-read-empty-dir')).toBe(
      'FAILURE'
    );
  });

  test('a server with no empty directory SKIPs directory-read-empty-dir', async () => {
    const f = goodFixture();
    f.dirs['skill://acme'] = (f.dirs['skill://acme'] as object[]).slice(0, 2);
    expect(await statusOf(f, 'sep-2640-directory-read-empty-dir')).toBe(
      'SKIPPED'
    );
  });
});
