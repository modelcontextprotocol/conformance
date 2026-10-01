import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { testScenarioContext } from '../mock-server/testing';
import { runConformanceTest } from '../runner/client';
import { LATEST_SPEC_VERSION } from '../types';
import {
  applyScenarioFiles,
  isCustomScenario,
  listCustomScenarios,
  loadCustomScenarios
} from './custom';
import {
  getClientScenario,
  getScenario,
  getScenarioSpecVersions,
  listAuthScenarios,
  listBackcompatScenarios,
  listCoreScenarios,
  listDraftScenarios,
  listExtensionScenarios,
  listMetadataScenarios,
  listScenariosForSpec
} from './index';

const EXAMPLE = 'examples/scenarios/trace-id.mjs';
const EXAMPLE_NAME = 'example/trace-id';
const EXAMPLE_CLIENT = 'node examples/scenarios/trace-id-client.mjs';

/** Source of a module that default-exports one scenario. */
const scenarioSource = (
  name: string,
  {
    start = `return { serverUrl: 'http://127.0.0.1:1/mcp' };`,
    checks = '[]'
  } = {}
) => `
export default {
  name: ${JSON.stringify(name)},
  description: 'test scenario',
  source: { introducedIn: '2025-11-25' },
  async start() { ${start} },
  async stop() {},
  getChecks() { return ${checks}; }
};
`;

let dir: string;
let files = 0;
const write = async (content: string, file = `file-${++files}.mjs`) => {
  await writeFile(path.join(dir, file), content);
  return path.join(dir, file);
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'custom-scenarios-'));
  await loadCustomScenarios([EXAMPLE]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadCustomScenarios', () => {
  test('registers the example scenario and marks it custom', () => {
    expect(getScenario(EXAMPLE_NAME)?.description).toContain('Example');
    expect(isCustomScenario(EXAMPLE_NAME)).toBe(true);
    expect(listCustomScenarios()).toContain(EXAMPLE_NAME);
    expect(isCustomScenario('initialize')).toBe(false);
  });

  test('a loaded scenario follows --spec-version', () => {
    expect(listScenariosForSpec(LATEST_SPEC_VERSION)).toContain(EXAMPLE_NAME);
    expect(listScenariosForSpec('2025-03-26')).not.toContain(EXAMPLE_NAME);
  });

  test('a loaded scenario joins no built-in suite', () => {
    const builtInSuites = [
      listCoreScenarios,
      listExtensionScenarios,
      listBackcompatScenarios,
      listAuthScenarios,
      listMetadataScenarios,
      listDraftScenarios
    ];
    for (const list of builtInSuites) {
      expect(list()).not.toContain(EXAMPLE_NAME);
    }
  });

  test('accepts an array of scenarios', async () => {
    const file = await write(
      `const make = (name) => ({
  name,
  description: 'test scenario',
  source: { introducedIn: '2025-11-25' },
  async start() { return { serverUrl: 'http://127.0.0.1:1/mcp' }; },
  async stop() {},
  getChecks() { return []; }
});
export default [make('custom/a'), make('custom/b')];`
    );
    expect(await loadCustomScenarios([file])).toEqual(['custom/a', 'custom/b']);
  });

  test.each([
    ['a client scenario', 'initialize'],
    ['a client scenario in another case', 'Initialize'],
    ['a server scenario', 'server-initialize'],
    [
      'an authorization server scenario',
      'authorization-server-metadata-endpoint'
    ],
    ['a scenario that is already loaded', EXAMPLE_NAME]
  ])('refuses the name of %s', async (_label, name) => {
    const client = getScenario('initialize');
    const versions = getScenarioSpecVersions('server-initialize');
    const file = await write(scenarioSource(name));
    await expect(loadCustomScenarios([file])).rejects.toThrow(
      `the scenario name '${name}' is already in use`
    );
    expect(getScenario('initialize')).toBe(client);
    expect(getScenario('server-initialize')).toBeUndefined();
    expect(getClientScenario('server-initialize')).toBeDefined();
    expect(getScenarioSpecVersions('server-initialize')).toEqual(versions);
    expect(isCustomScenario(name)).toBe(name === EXAMPLE_NAME);
  });

  test('refuses the same name in two files', async () => {
    const a = await write(scenarioSource('custom/dup'));
    const b = await write(scenarioSource('custom/dup'), 'dup-b.mjs');
    await expect(loadCustomScenarios([a, b])).rejects.toThrow(
      /dup-b\.mjs: the scenario name 'custom\/dup' is already in use/
    );
    expect(getScenario('custom/dup')).toBeUndefined();
  });

  test('registers nothing when any scenario is unusable', async () => {
    const good = await write(scenarioSource('custom/good'));
    const bad = await write(
      `export default { name: 'custom/bad', description: 'no methods', source: { introducedIn: '2025-11-25' } };`,
      'bad.mjs'
    );
    await expect(loadCustomScenarios([good, bad])).rejects.toThrow(
      /bad\.mjs: scenario 1 has no `start\(\)` method/
    );
    expect(getScenario('custom/good')).toBeUndefined();
  });

  test.each([
    ['no default export', `export const scenario = {};`, /no default export/],
    ['an empty array', `export default [];`, /empty array/],
    ['a non-object', `export default 'scenario';`, /is not an object/],
    [
      'an unknown spec version',
      scenarioSource('custom/version').replace('2025-11-25', '2099-01-01'),
      /needs a `source` of known spec versions/
    ],
    [
      'an extension id in place of a spec version',
      scenarioSource('custom/extension').replace(
        `introducedIn: '2025-11-25'`,
        `extensionId: 'com.example/extension'`
      ),
      /needs a `source` of known spec versions/
    ],
    [
      'an extension id next to a spec version',
      scenarioSource('custom/both').replace(
        `introducedIn: '2025-11-25'`,
        `introducedIn: '2025-11-25', extensionId: 'com.example/extension'`
      ),
      /needs a `source` of known spec versions/
    ],
    [
      'the second of two scenarios',
      `const first = ${scenarioSource('custom/first').replace('export default', '').trim().replace(/;$/, '')};
export default [first, { name: 'custom/second' }];`,
      /scenario 2 has no `description`/
    ],
    [
      'a module that throws',
      `throw new Error('boom');`,
      /file-\d+\.mjs: could not be loaded: boom/
    ],
    [
      'a module with a syntax error',
      `export default {`,
      /file-\d+\.mjs: could not be loaded: /
    ]
  ])('refuses %s', async (_label, content, message) => {
    const file = await write(content);
    await expect(loadCustomScenarios([file])).rejects.toThrow(message);
  });

  test.each([
    '',
    '../../escape',
    'a/../b',
    '/absolute',
    'trailing/',
    '.hidden',
    '_private',
    ' padded ',
    'acme:hello',
    'two\nlines',
    'colour\u001b[31m'
  ])('refuses the name %j', async (name) => {
    const file = await write(scenarioSource(name));
    await expect(loadCustomScenarios([file])).rejects.toThrow(/has the name /);
  });

  test('refuses a missing file and a directory', async () => {
    const missing = path.join(dir, 'nope.mjs');
    await expect(loadCustomScenarios([missing])).rejects.toThrow(
      /nope\.mjs: could not be loaded: /
    );
    await expect(loadCustomScenarios([dir])).rejects.toThrow(
      ': could not be loaded: '
    );
  });
});

describe('checks returned by a loaded scenario', () => {
  const load = async (
    name: string,
    parts: Parameters<typeof scenarioSource>[1]
  ) => {
    await loadCustomScenarios([await write(scenarioSource(name, parts))]);
    return getScenario(name)!;
  };
  const check = (fields: object) =>
    JSON.stringify([
      {
        id: 'a-check',
        name: 'ACheck',
        description: 'a check',
        status: 'SUCCESS',
        timestamp: '2026-01-01T00:00:00.000Z',
        ...fields
      }
    ]);

  test('a valid check passes through', async () => {
    const scenario = await load('checked/valid', { checks: check({}) });
    expect(scenario.getChecks()).toMatchObject([
      { id: 'a-check', status: 'SUCCESS' }
    ]);
  });

  test('a frozen array of checks can be extended by the runner', async () => {
    const scenario = await load('checked/frozen', {
      checks: `Object.freeze(${check({})})`
    });
    expect(() =>
      scenario.getChecks().push(...scenario.getChecks())
    ).not.toThrow();
  });

  test('allowClientError set in start() reaches the runner', async () => {
    const scenario = await load('checked/allow', {
      start: `this.allowClientError = true; return { serverUrl: 'http://127.0.0.1:1/mcp' };`
    });
    expect(scenario.allowClientError).toBeUndefined();
    await scenario.start(testScenarioContext());
    expect(scenario.allowClientError).toBe(true);
  });

  test.each([
    [
      'mistyped-status',
      check({ status: 'PASS' }),
      /check 1 has the status "PASS"; use one of SUCCESS, FAILURE/
    ],
    ['missing-id', check({ id: undefined }), /check 1 has no `id`/],
    ['not-an-object', `['SUCCESS']`, /check 1 is not an object/],
    [
      'a-promise',
      `Promise.resolve([])`,
      /getChecks\(\) must return an array of checks/
    ]
  ])('getChecks() returning %s throws', async (label, checks, message) => {
    const scenario = await load(`checked/${label}`, { checks });
    expect(() => scenario.getChecks()).toThrow(message);
  });
});

describe('applyScenarioFiles', () => {
  type Options = Parameters<typeof applyScenarioFiles>[0];

  test('does nothing without files', async () => {
    const options: Options = { suite: 'core' };
    expect(await applyScenarioFiles(options)).toEqual([]);
    expect(options).toEqual({ suite: 'core' });
  });

  test('refuses --suite custom without files', async () => {
    await expect(applyScenarioFiles({ suite: 'custom' })).rejects.toThrow(
      '--suite custom needs at least one --scenario-file'
    );
  });

  test.each([
    [{ requirements: '2025-11-25' }, /cannot be combined with --requirements/],
    [{ suite: 'all' }, /cannot be combined with --suite all/],
    [{ suite: 'core' }, /cannot be combined with --suite core/],
    [
      { scenario: 'initialize' },
      /cannot be combined with the built-in scenario 'initialize'/
    ]
  ])('refuses %j before importing anything', async (selection, message) => {
    const file = await write(`throw new Error('must not be imported');`);
    await expect(
      applyScenarioFiles({ scenarioFile: [file], ...selection })
    ).rejects.toThrow(message);
  });

  test('selects the custom suite when no scenario is named', async () => {
    const file = await write(scenarioSource('apply/suite'));
    const options: Options = { scenarioFile: [file] };
    expect(await applyScenarioFiles(options)).toEqual(['apply/suite']);
    expect(options.suite).toBe('custom');
  });

  test('keeps a named scenario that the files define', async () => {
    const file = await write(scenarioSource('apply/named'));
    const options: Options = { scenarioFile: [file], scenario: 'apply/named' };
    await applyScenarioFiles(options);
    expect(options.suite).toBeUndefined();
  });

  test('refuses a named scenario that the files do not define', async () => {
    const file = await write(scenarioSource('apply/other'));
    await expect(
      applyScenarioFiles({ scenarioFile: [file], scenario: 'apply/missing' })
    ).rejects.toThrow(
      '--scenario apply/missing is not one of the loaded scenarios: apply/other'
    );
  });
});

describe('the example scenario', () => {
  const own = (checks: { id: string; status: string }[]) =>
    checks
      .filter((c) => c.id.startsWith('example-'))
      .map((c) => [c.id, c.status]);

  test('passes with the example client', async () => {
    const result = await runConformanceTest(
      EXAMPLE_CLIENT,
      EXAMPLE_NAME,
      20000
    );
    expect(result.clientOutput?.exitCode).toBe(0);
    expect(own(result.checks)).toEqual([
      ['example-tool-called', 'SUCCESS'],
      ['example-trace-id-sent', 'SUCCESS']
    ]);
    expect(result.checks.some((c) => c.status === 'FAILURE')).toBe(false);
  }, 30000);

  test('fails with a client that does nothing', async () => {
    const result = await runConformanceTest('node -e ""', EXAMPLE_NAME, 20000);
    expect(own(result.checks)).toEqual([
      ['example-tool-called', 'FAILURE'],
      ['example-trace-id-sent', 'FAILURE']
    ]);
  }, 30000);

  test('fails only the trace id check when a call is untagged', async () => {
    const scenario = getScenario(EXAMPLE_NAME)!;
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const client = new Client({ name: 'untagged', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(serverUrl))
      );
      await client.callTool({
        name: 'echo',
        arguments: { text: 'a' },
        _meta: { 'com.example/traceId': 'trace-0001' }
      });
      await client.callTool({ name: 'echo', arguments: { text: 'b' } });
      await client.close();
      expect(scenario.getChecks()).toMatchObject([
        { id: 'example-tool-called', status: 'SUCCESS' },
        {
          id: 'example-trace-id-sent',
          status: 'FAILURE',
          errorMessage: '1 of 2 tool calls had no trace id'
        }
      ]);
    } finally {
      await scenario.stop();
    }
  });
});
