import { describe, test, expect } from 'vitest';
import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { withRequiredDraftResultFields } from '../../../mock-server';
import {
  takeWireViolations,
  formatWireViolation
} from '../../../validation/wire-schema';
import { SkillsEnumerationScenario } from './enumeration';
import { SKILLS_EXTENSION_ID } from './helpers';

/**
 * Negative controls for the SEP-2640 capability checks.
 *
 * `sep-2640-capability-empty-object` used to report a hardcoded SUCCESS, so it
 * could not fail and was checking nothing (PR #330 review). It now asserts the
 * observable half of "an empty object indicates support for the extension with
 * no optional features": the declared value must be an object at all.
 *
 * The same change closes a false SKIP. A server declaring the extension as
 * `true` used to be folded into "extension not declared" and skipped the whole
 * suite, which read as a clean run against a server that is plainly wrong.
 *
 * A non-object declaration also violates the base `DiscoverResult` schema, so
 * the harness's wire validation catches it independently. That is belt and
 * braces, not redundancy: the scenario's job is to stop *masking* the problem
 * with a SKIP, and the tests below assert both halves. The malformed cases
 * emit those violations deliberately and drain them.
 */

/** A listed entry that is well formed apart from whatever the test is probing. */
function entryFor(name: string) {
  const uri = `skill://${name}/SKILL.md`;
  return {
    uri,
    frontmatter: { name, description: 'A negative-control fixture skill.' },
    resources: [
      {
        uri,
        digest: `sha256:${'0'.repeat(64)}`,
        size: 1
      }
    ]
  };
}

function jsonRpcResult(id: unknown, method: string, result: object): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: withRequiredDraftResultFields(method, result)
  });
}

async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * A minimal SEP-2575 stateless server whose only interesting property is the
 * value it declares the skills extension with. Everything else answers just
 * enough for the scenario to reach its capability checks.
 */
function startServerDeclaring(
  declared: unknown,
  skills: object[] = [],
  files: Record<string, string> = {}
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readJsonBody(req);
    const method = body.method as string;
    const id = body.id;
    const send = (result: object) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jsonRpcResult(id, method, result));
    };

    if (method === 'server/discover') {
      const extensions =
        declared === undefined ? {} : { [SKILLS_EXTENSION_ID]: declared };
      send({
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities: { resources: {}, extensions },
        serverInfo: { name: 'skills-negative', version: '1.0.0' }
      });
      return;
    }
    if (method === 'skills/list') {
      send({ skills });
      return;
    }
    if (method === 'resources/read') {
      const uri = (body.params as { uri?: string } | undefined)?.uri;
      if (uri !== undefined && uri in files) {
        send({
          contents: [{ uri, mimeType: 'text/markdown', text: files[uri] }]
        });
        return;
      }
    }
    if (method === 'resources/list') {
      send({ resources: [] });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      })
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://localhost:${addr.port}/mcp`, server });
    });
  });
}

async function runAgainst(
  declared: unknown,
  skills: object[] = [],
  files: Record<string, string> = {}
) {
  const { url, server } = await startServerDeclaring(declared, skills, files);
  try {
    const scenario = new SkillsEnumerationScenario();
    const checks = await scenario.run(testContext(url, DRAFT_PROTOCOL_VERSION));
    return {
      checks: new Map(checks.map((c) => [c.id, c])),
      // Drained here so an intentionally malformed declaration does not trip
      // the global vitest hook; the tests assert on the drained result.
      violations: takeWireViolations().violations
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function checksFor(
  declared: unknown,
  skills: object[] = [],
  files: Record<string, string> = {}
) {
  const { checks, violations } = await runAgainst(declared, skills, files);
  expect(violations, 'unexpected wire-schema violations').toEqual([]);
  return checks;
}

const EMPTY_OBJECT_ID = 'sep-2640-capability-empty-object';
const INLINE_ID = 'sep-2640-capability-declaration-inline';

describe('SEP-2640 capability declaration', () => {
  test('an empty object is a valid declaration', async () => {
    const checks = await checksFor({});
    expect(checks.get(EMPTY_OBJECT_ID)?.status).toBe('SUCCESS');
    expect(checks.get(INLINE_ID)?.status).toBe('SUCCESS');
  });

  test('a non-empty settings object is a valid declaration', async () => {
    const checks = await checksFor({ directoryRead: true });
    expect(checks.get(EMPTY_OBJECT_ID)?.status).toBe('SUCCESS');
    expect(checks.get(INLINE_ID)?.status).toBe('SUCCESS');
  });

  test.each([
    ['true', true],
    ['a string', 'yes'],
    ['an array', []],
    ['null', null]
  ])(
    'declaring the extension as %s is a FAILURE, not a SKIP',
    async (_label, value) => {
      const { checks, violations } = await runAgainst(value);
      expect(checks.get(EMPTY_OBJECT_ID)?.status).toBe('FAILURE');
      // No settings object means no envelope question to answer.
      expect(checks.get(INLINE_ID)?.status).toBe('SKIPPED');
      // The base DiscoverResult schema rejects it too; both must fire.
      expect(
        violations.some((v) =>
          /extensions.*must be object/.test(formatWireViolation(v))
        ),
        'expected a DiscoverResult wire-schema violation'
      ).toBe(true);
    }
  );

  test('an envelope instead of inline settings is a FAILURE', async () => {
    const checks = await checksFor({ config: { directoryRead: true } });
    expect(checks.get(EMPTY_OBJECT_ID)?.status).toBe('SUCCESS');
    expect(checks.get(INLINE_ID)?.status).toBe('FAILURE');
  });

  test('an undeclared extension skips every check', async () => {
    const checks = await checksFor(undefined);
    expect(checks.get(EMPTY_OBJECT_ID)?.status).toBe('SKIPPED');
    expect(checks.get(INLINE_ID)?.status).toBe('SKIPPED');
    expect([...checks.values()].every((c) => c.status === 'SKIPPED')).toBe(
      true
    );
  });
});

/**
 * Valid and invalid `name` examples reproduced from the Agent Skills
 * specification, which SEP-2640 defers to for naming
 * (https://agentskills.io/specification#name-field). The consecutive-hyphen
 * rule is the one the first pass of this check missed.
 */
const NAMING_ID = 'sep-2640-name-naming-rules';

describe('SEP-2640 skill naming rules', () => {
  test.each(['pdf-processing', 'data-analysis', 'code-review', 'a', 'a1'])(
    'accepts %s',
    async (name) => {
      const checks = await checksFor({}, [entryFor(name)]);
      expect(checks.get(NAMING_ID)?.status).toBe('SUCCESS');
    }
  );

  test.each([
    ['consecutive hyphens', 'pdf--processing'],
    ['a leading hyphen', '-pdf'],
    ['a trailing hyphen', 'pdf-'],
    ['65 characters', 'a'.repeat(65)]
  ])('rejects %s', async (_label, name) => {
    const checks = await checksFor({}, [entryFor(name)]);
    expect(checks.get(NAMING_ID)?.status).toBe('FAILURE');
  });
});

/**
 * `entry-frontmatter-identical` compares content, not serialisation. A server
 * whose JSON encoder orders map keys differently from the YAML source (Go's
 * encoding/json sorts them) is conformant and must pass.
 */
const IDENTICAL_ID = 'sep-2640-entry-frontmatter-identical';

function skillWithFile(
  yamlMetadata: string,
  entryMetadata: Record<string, string>
) {
  const uri = 'skill://demo/SKILL.md';
  const text = `---\nname: demo\ndescription: Demo skill\nmetadata:\n${yamlMetadata}---\n\nBody.\n`;
  const entry = {
    uri,
    frontmatter: {
      name: 'demo',
      description: 'Demo skill',
      metadata: entryMetadata
    },
    resources: [
      {
        uri,
        digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        size: Buffer.byteLength(text)
      }
    ]
  };
  return { entry, files: { [uri]: text } };
}

describe('SEP-2640 frontmatter identity', () => {
  test('nested keys serialised in a different order are identical', async () => {
    const { entry, files } = skillWithFile('  version: "1.0"\n  author: me\n', {
      author: 'me',
      version: '1.0'
    });
    const checks = await checksFor({}, [entry], files);
    expect(checks.get(IDENTICAL_ID)?.status).toBe('SUCCESS');
  });

  test('a differing nested value is a FAILURE', async () => {
    const { entry, files } = skillWithFile('  version: "1.0"\n  author: me\n', {
      author: 'someone-else',
      version: '1.0'
    });
    const checks = await checksFor({}, [entry], files);
    expect(checks.get(IDENTICAL_ID)?.status).toBe('FAILURE');
  });
});
