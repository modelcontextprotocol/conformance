import { describe, test, expect } from 'vitest';
import { testScenarioContext } from '../../../mock-server/testing';
import { sendStatelessRequest } from '../../../connection/stateless';
import { DRAFT_PROTOCOL_VERSION, type Scenario } from '../../../types';
import {
  SkillsLoadByUriScenario,
  SkillsInvalidEntryScenario,
  SkillsDirectoryUnlistedChildScenario,
  SkillsTwoOriginsScenario
} from './hosting';

/**
 * Each scenario runs against small scripted clients. A client that follows
 * the contract and the spec passes. Each negative client breaks one rule, and
 * the matching check must fail. A client that skips the prerequisite gets an
 * untestable FAILURE rather than a pass.
 */

type Call = (method: string, params?: Record<string, unknown>) => Promise<any>;

function caller(url: string): Call {
  return async (method, params) => {
    const res = await sendStatelessRequest(url, method, params, {
      specVersion: DRAFT_PROTOCOL_VERSION,
      skipValidation: true
    });
    return res.body;
  };
}

async function run(
  scenario: Scenario,
  client: (call: Call, context: any, second?: Call) => Promise<void>
) {
  const urls = await scenario.start(
    testScenarioContext(DRAFT_PROTOCOL_VERSION)
  );
  try {
    const second = urls.context?.secondServerUrl as string | undefined;
    await client(
      caller(urls.serverUrl),
      urls.context,
      second ? caller(second) : undefined
    );
    return new Map(scenario.getChecks().map((c) => [c.id, c]));
  } finally {
    await scenario.stop();
  }
}

/** Reads every file an entry lists, which is what a verifying load does. */
async function load(call: Call, entry: any) {
  for (const r of entry.resources ?? []) {
    await call('resources/read', { uri: r.uri });
  }
}

const listed = async (call: Call) =>
  ((await call('skills/list')).result?.skills ?? []) as any[];

describe('sep-2640-client-load-by-uri', () => {
  const ids = [
    'sep-2640-host-load-by-uri',
    'sep-2640-host-no-empty-listing-assumption'
  ];

  test('listing, then skills/get and a read, passes both checks', async () => {
    const checks = await run(
      new SkillsLoadByUriScenario(),
      async (call, ctx) => {
        await listed(call);
        const got = await call('skills/get', { uri: ctx.skillUri });
        await call('resources/read', { uri: got.result.skill.uri });
      }
    );
    expect(ids.map((id) => checks.get(id)?.status)).toEqual([
      'SUCCESS',
      'SUCCESS'
    ]);
  });

  test('stopping at the empty listing fails both checks', async () => {
    const checks = await run(new SkillsLoadByUriScenario(), async (call) => {
      await listed(call);
    });
    expect(ids.map((id) => checks.get(id)?.status)).toEqual([
      'FAILURE',
      'FAILURE'
    ]);
  });

  test('resolving the entry without reading the SKILL.md fails load-by-uri', async () => {
    const checks = await run(
      new SkillsLoadByUriScenario(),
      async (call, ctx) => {
        await listed(call);
        await call('skills/get', { uri: ctx.skillUri });
      }
    );
    expect(checks.get('sep-2640-host-load-by-uri')?.status).toBe('FAILURE');
  });
});

describe('sep-2640-client-invalid-entry', () => {
  const id = 'sep-2640-resources-invalid-entry';
  const isValid = (e: any) =>
    Array.isArray(e.resources) || e.resources === 'dynamic';

  test('loading only the valid entry passes', async () => {
    const checks = await run(new SkillsInvalidEntryScenario(), async (call) => {
      for (const e of await listed(call)) if (isValid(e)) await load(call, e);
    });
    expect(checks.get(id)?.status).toBe('SUCCESS');
  });

  test('loading an entry with no resources fails', async () => {
    const checks = await run(new SkillsInvalidEntryScenario(), async (call) => {
      for (const e of await listed(call)) {
        await call('resources/read', { uri: e.uri });
      }
    });
    expect(checks.get(id)?.status).toBe('FAILURE');
  });

  test('loading nothing is untestable, not a pass', async () => {
    const checks = await run(new SkillsInvalidEntryScenario(), async (call) => {
      await listed(call);
    });
    expect(checks.get(id)?.status).toBe('FAILURE');
    expect(checks.get(id)?.details?.untestable).toBe(true);
  });
});

describe('sep-2640-client-directory-unlisted-child', () => {
  const id = 'sep-2640-directory-read-not-manifest-extension';

  async function walk(
    call: Call,
    readChild: (uri: string, entry: any) => boolean
  ) {
    const [entry] = await listed(call);
    await load(call, entry);
    const queue = ['skill://pdf-processing'];
    while (queue.length) {
      const dir = await call('resources/directory/read', {
        uri: queue.shift()
      });
      for (const c of dir.result?.resources ?? []) {
        if (c.mimeType === 'inode/directory') queue.push(c.uri);
        else if (readChild(c.uri, entry))
          await call('resources/read', { uri: c.uri });
      }
    }
  }

  test('reading only children the entry lists passes', async () => {
    const checks = await run(
      new SkillsDirectoryUnlistedChildScenario(),
      async (call) => {
        await walk(call, (uri, entry) =>
          entry.resources.some((r: any) => r.uri === uri)
        );
      }
    );
    expect(checks.get(id)?.status).toBe('SUCCESS');
  });

  test('reading a child the entry does not list fails', async () => {
    const checks = await run(
      new SkillsDirectoryUnlistedChildScenario(),
      async (call) => {
        await walk(call, () => true);
      }
    );
    expect(checks.get(id)?.status).toBe('FAILURE');
  });
});

describe('sep-2640-client-two-origins', () => {
  const ids = [
    'sep-2640-host-skill-identity-pair',
    'sep-2640-host-cross-origin-no-shadow',
    'sep-2640-host-reads-bound-to-origin'
  ];

  test('loading each server’s skills from that server passes every check', async () => {
    const checks = await run(
      new SkillsTwoOriginsScenario(),
      async (a, _c, b) => {
        for (const call of [a, b!]) {
          for (const e of await listed(call)) await load(call, e);
        }
      }
    );
    expect(ids.map((id) => checks.get(id)?.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'SUCCESS'
    ]);
  });

  test('caching by uri alone fails identity-pair', async () => {
    const checks = await run(
      new SkillsTwoOriginsScenario(),
      async (a, _c, b) => {
        const seen = new Set<string>();
        for (const call of [a, b!]) {
          for (const e of await listed(call)) {
            if (seen.has(e.uri)) continue;
            seen.add(e.uri);
            await load(call, e);
          }
        }
      }
    );
    expect(checks.get(ids[0])?.status).toBe('FAILURE');
  });

  test('keying skills by name alone fails cross-origin-no-shadow', async () => {
    const checks = await run(
      new SkillsTwoOriginsScenario(),
      async (a, _c, b) => {
        const byName = new Map<string, [Call, any]>();
        for (const call of [a, b!]) {
          for (const e of await listed(call))
            byName.set(e.frontmatter.name, [call, e]);
        }
        for (const [call, e] of byName.values()) await load(call, e);
      }
    );
    expect(checks.get(ids[1])?.status).toBe('FAILURE');
  });

  test('reading one server’s files from the other fails reads-bound-to-origin', async () => {
    const checks = await run(
      new SkillsTwoOriginsScenario(),
      async (a, _c, b) => {
        const all: any[] = [...(await listed(a)), ...(await listed(b!))];
        for (const call of [a, b!]) for (const e of all) await load(call, e);
      }
    );
    expect(checks.get(ids[2])?.status).toBe('FAILURE');
  });

  test('listing only one server is untestable', async () => {
    const checks = await run(new SkillsTwoOriginsScenario(), async (a) => {
      for (const e of await listed(a)) await load(a, e);
    });
    expect(ids.every((id) => checks.get(id)?.details?.untestable)).toBe(true);
  });
});
