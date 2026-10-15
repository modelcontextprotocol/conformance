import { describe, test, expect } from 'vitest';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { takeWireViolations } from '../../../validation/wire-schema';
import { AgentsDiscoveryScenario } from './discovery';
import { AgentsListChangedScenario } from './list-changed';
import {
  BROKEN_AGENT,
  HIDDEN_AGENT,
  catalog,
  startAgentsFixture,
  type AgentsFixtureOptions
} from './negative-fixture';

/**
 * Negative controls for the agent discovery scenarios.
 *
 * A passing run against a conformant fixture proves a check does not
 * false-positive. It does not prove the check catches anything, which is what
 * these tests are for: each one breaks the fixture in exactly one way and
 * asserts the matching check flips. The fixture lives in negative-fixture.ts.
 */

type Scenario = AgentsDiscoveryScenario | AgentsListChangedScenario;

async function checksFor(scenario: Scenario, opts: AgentsFixtureOptions) {
  const fixture = await startAgentsFixture(opts);
  try {
    const checks = await scenario.run(
      testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    // Drained so an intentionally malformed response does not trip the global
    // vitest hook; these tests assert on the check, not the wire validator.
    takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await fixture.close();
  }
}

const discovery = () => new AgentsDiscoveryScenario();
const listChanged = () => new AgentsListChangedScenario();

describe('agents discovery: a conformant fixture', () => {
  test('every check passes, and only the optional ones skip', async () => {
    const checks = await checksFor(discovery(), {});
    const notPassing = [...checks.values()]
      .filter((c) => c.status !== 'SUCCESS')
      .map((c) => `${c.id}: ${c.status} ${c.errorMessage ?? ''}`);
    expect(notPassing).toEqual([]);
    expect(checks.size).toBe(27);
  });

  test('each check ID is emitted exactly once', async () => {
    const fixture = await startAgentsFixture({});
    try {
      const checks = await discovery().run(
        testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
      );
      takeWireViolations();
      const ids = checks.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await fixture.close();
    }
  });
});

describe('agents discovery: capability', () => {
  test('an undeclared extension the server does not serve skips everything', async () => {
    const checks = await checksFor(discovery(), {
      declared: null,
      listUnimplemented: true
    });
    expect([...checks.values()].every((c) => c.status === 'SKIPPED')).toBe(
      true
    );
  });

  test('serving agents/list without declaring the extension fails', async () => {
    const checks = await checksFor(discovery(), { declared: null });
    expect(checks.get('sep-9998-capability-declared')?.status).toBe('FAILURE');
  });

  test('a declaration that is not a settings object fails', async () => {
    const checks = await checksFor(discovery(), { declared: true });
    expect(checks.get('sep-9998-capability-declared')?.status).toBe('FAILURE');
  });

  test('a non-boolean listChanged fails', async () => {
    const checks = await checksFor(discovery(), {
      declared: { listChanged: 'yes' }
    });
    expect(checks.get('sep-9998-capability-list-changed-boolean')?.status).toBe(
      'FAILURE'
    );
  });

  test('refusing tools/list to a client without the extension fails', async () => {
    const checks = await checksFor(discovery(), {
      coreRequiresExtension: true
    });
    expect(checks.get('sep-9998-core-without-extension')?.status).toBe(
      'FAILURE'
    );
  });
});

describe('agents discovery: roster', () => {
  test('a declared extension without agents/list fails', async () => {
    const checks = await checksFor(discovery(), { listUnimplemented: true });
    expect(checks.get('sep-9998-list-implemented')?.status).toBe('FAILURE');
  });

  test('a page without resultType fails', async () => {
    const checks = await checksFor(discovery(), {
      listOverrides: { resultType: 'incomplete' }
    });
    expect(checks.get('sep-9998-list-result-shape')?.status).toBe('FAILURE');
  });

  test('a cursor that never ends fails', async () => {
    const checks = await checksFor(discovery(), { loopingCursor: true });
    expect(checks.get('sep-9998-list-pagination')?.status).toBe('FAILURE');
  });

  test('a page without ttlMs fails', async () => {
    const checks = await checksFor(discovery(), {
      listOverrides: { ttlMs: undefined }
    });
    expect(checks.get('sep-9998-list-cacheable')?.status).toBe('FAILURE');
  });

  test('a card whose name is not a string fails', async () => {
    const checks = await checksFor(discovery(), {
      cardOverrides: { 'writer-agent': { name: 7 } }
    });
    expect(checks.get('sep-9998-card-name')?.status).toBe('FAILURE');
  });

  test('a description that is not a string fails', async () => {
    const checks = await checksFor(discovery(), {
      cardOverrides: { 'writer-agent': { description: 3 } }
    });
    expect(checks.get('sep-9998-card-description-type')?.status).toBe(
      'FAILURE'
    );
  });

  test('a card without capabilities fails', async () => {
    const checks = await checksFor(discovery(), {
      cardOverrides: { 'writer-agent': { capabilities: undefined } }
    });
    expect(checks.get('sep-9998-card-capabilities')?.status).toBe('FAILURE');
  });

  test('a card carrying instructions warns', async () => {
    const checks = await checksFor(discovery(), {
      cardOverrides: { 'writer-agent': { instructions: 'leaked' } }
    });
    expect(checks.get('sep-9998-list-cards-only')?.status).toBe('WARNING');
  });

  test('a name listed on two pages fails', async () => {
    const checks = await checksFor(discovery(), {
      cardOverrides: { 'writer-agent': { name: 'research-agent' } }
    });
    expect(checks.get('sep-9998-name-unique')?.status).toBe('FAILURE');
  });
});

describe('agents discovery: details', () => {
  test('agents/get failing for a listed agent fails', async () => {
    const checks = await checksFor(discovery(), { getFails: ['writer-agent'] });
    expect(checks.get('sep-9998-get-implemented')?.status).toBe('FAILURE');
  });

  test('a details result without resultType fails', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: { 'writer-agent': { resultType: 'incomplete' } }
    });
    expect(checks.get('sep-9998-get-result-shape')?.status).toBe('FAILURE');
  });

  test('a details result naming another agent fails', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: { 'writer-agent': { agent: 'research-agent' } }
    });
    expect(checks.get('sep-9998-get-agent-name')?.status).toBe('FAILURE');
  });

  test('a details result without cacheScope fails', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: { 'writer-agent': { cacheScope: undefined } }
    });
    expect(checks.get('sep-9998-get-cacheable')?.status).toBe('FAILURE');
  });

  test('a role outside the enum fails', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: {
        'research-agent': { modelRoutingHint: { role: 'huge', vision: false } }
      }
    });
    expect(checks.get('sep-9998-hint-role')?.status).toBe('FAILURE');
  });

  test('a hint without vision fails', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: {
        'research-agent': { modelRoutingHint: { role: 'small' } }
      }
    });
    expect(checks.get('sep-9998-hint-vision')?.status).toBe('FAILURE');
  });

  test('no hint anywhere skips the hint rows', async () => {
    const checks = await checksFor(discovery(), {
      getOverrides: { 'research-agent': { modelRoutingHint: undefined } }
    });
    expect(checks.get('sep-9998-hint-role')?.status).toBe('SKIPPED');
    expect(checks.get('sep-9998-hint-vision')?.status).toBe('SKIPPED');
  });
});

describe('agents discovery: tool parity', () => {
  test('a returned tool missing from tools/list fails all three parity rows', async () => {
    const checks = await checksFor(discovery(), {
      getTools: {
        'writer-agent': [
          ...catalog().slice(0, 2),
          {
            name: 'unlisted_tool',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    });
    for (const id of [
      'sep-9998-get-tools-in-tools-list',
      'sep-9998-get-tools-intersection',
      'sep-9998-tools-list-not-omitted'
    ]) {
      expect(checks.get(id)?.status, id).toBe('FAILURE');
    }
    expect(checks.get('sep-9998-get-tools-fields-match')?.status).toBe(
      'SUCCESS'
    );
  });

  test('a returned tool whose fields differ from tools/list fails', async () => {
    const [search, summarize] = catalog();
    const checks = await checksFor(discovery(), {
      getTools: {
        'writer-agent': [search, { ...summarize, description: 'Different.' }]
      }
    });
    expect(checks.get('sep-9998-get-tools-fields-match')?.status).toBe(
      'FAILURE'
    );
    expect(checks.get('sep-9998-get-tools-in-tools-list')?.status).toBe(
      'SUCCESS'
    );
  });

  test('a shared tool that differs between agents fails', async () => {
    const [search, summarize] = catalog();
    const checks = await checksFor(discovery(), {
      getTools: {
        'writer-agent': [
          { ...search, description: 'Another search.' },
          summarize
        ]
      }
    });
    expect(checks.get('sep-9998-shared-tool-same-definition')?.status).toBe(
      'FAILURE'
    );
  });
});

describe('agents discovery: errors and visibility', () => {
  test('an unknown name without the agent_not_found reason fails', async () => {
    const checks = await checksFor(discovery(), {
      unknownError: { code: -32602, message: 'agent not found' }
    });
    expect(checks.get('sep-9998-agent-not-found')?.status).toBe('FAILURE');
  });

  test('a hidden agent answering differently from an unknown one fails', async () => {
    const checks = await checksFor(discovery(), {
      hiddenError: {
        code: -32602,
        message: 'you may not see this agent',
        data: { reason: 'agent_not_found' }
      }
    });
    expect(checks.get('sep-9998-hidden-indistinguishable')?.status).toBe(
      'FAILURE'
    );
    expect(checks.get('sep-9998-roster-filtered')?.status).toBe('SUCCESS');
  });

  test('a hidden agent listed in the roster fails', async () => {
    const checks = await checksFor(discovery(), { listHidden: true });
    expect(checks.get('sep-9998-roster-filtered')?.status).toBe('FAILURE');
    expect(checks.get('sep-9998-hidden-indistinguishable')?.status).toBe(
      'SUCCESS'
    );
  });

  test('a broken agent answering -32602 fails', async () => {
    const checks = await checksFor(discovery(), {
      brokenError: {
        code: -32602,
        message: 'missing tool',
        data: { reason: 'invalid_agent_definition' }
      }
    });
    expect(checks.get('sep-9998-invalid-agent-definition')?.status).toBe(
      'FAILURE'
    );
  });

  test('a broken agent answering -32603 without the reason fails', async () => {
    const checks = await checksFor(discovery(), {
      brokenError: { code: -32603, message: 'missing tool' }
    });
    expect(checks.get('sep-9998-invalid-agent-definition')?.status).toBe(
      'FAILURE'
    );
  });

  test('without the fixture control the three rows report untestable', async () => {
    const checks = await checksFor(discovery(), {
      withoutControls: ['agents_conformance_fixture']
    });
    for (const id of [
      'sep-9998-hidden-indistinguishable',
      'sep-9998-roster-filtered',
      'sep-9998-invalid-agent-definition'
    ]) {
      const c = checks.get(id);
      expect(c?.status, id).toBe('FAILURE');
      expect(c?.details?.untestable, id).toBe(true);
    }
    // Without the control the broken agent is opened like any other, and its
    // -32603 is reported where it lands.
    expect(checks.get('sep-9998-get-implemented')?.errorMessage).toContain(
      BROKEN_AGENT
    );
    expect(HIDDEN_AGENT).toBe('hidden-agent');
  });
});

describe('agents list_changed', () => {
  test('a conformant fixture passes', async () => {
    const checks = await checksFor(listChanged(), {});
    expect(checks.get('sep-9998-list-changed-not-declared')?.status).toBe(
      'SKIPPED'
    );
    for (const id of [
      'sep-9998-list-changed-acknowledged',
      'sep-9998-list-changed-notification',
      'sep-9998-list-changed-roster-updated'
    ]) {
      expect(
        checks.get(id)?.status,
        `${id}: ${checks.get(id)?.errorMessage}`
      ).toBe('SUCCESS');
    }
  });

  test('an undeclared extension skips everything', async () => {
    const checks = await checksFor(listChanged(), { declared: null });
    expect([...checks.values()].every((c) => c.status === 'SKIPPED')).toBe(
      true
    );
  });

  test('acknowledging the key without declaring listChanged fails', async () => {
    const checks = await checksFor(listChanged(), {
      declared: {},
      ackAlways: true
    });
    expect(checks.get('sep-9998-list-changed-not-declared')?.status).toBe(
      'FAILURE'
    );
  });

  test('not acknowledging the key without declaring listChanged passes', async () => {
    const checks = await checksFor(listChanged(), { declared: {} });
    expect(checks.get('sep-9998-list-changed-not-declared')?.status).toBe(
      'SUCCESS'
    );
  });

  test('declaring listChanged but dropping the key fails', async () => {
    const checks = await checksFor(listChanged(), { ackDropsKey: true });
    expect(checks.get('sep-9998-list-changed-acknowledged')?.status).toBe(
      'FAILURE'
    );
  });

  test('a roster change without the notification fails', async () => {
    const checks = await checksFor(listChanged(), { silentAdd: true });
    expect(checks.get('sep-9998-list-changed-notification')?.status).toBe(
      'FAILURE'
    );
  }, 15000);

  test('a notification whose change never shows in agents/list warns', async () => {
    const checks = await checksFor(listChanged(), { addWithoutChange: true });
    expect(checks.get('sep-9998-list-changed-notification')?.status).toBe(
      'SUCCESS'
    );
    expect(checks.get('sep-9998-list-changed-roster-updated')?.status).toBe(
      'WARNING'
    );
  });

  test('without the add control the two rows report untestable', async () => {
    const checks = await checksFor(listChanged(), {
      withoutControls: ['agents_conformance_add_agent']
    });
    expect(
      checks.get('sep-9998-list-changed-notification')?.details?.untestable
    ).toBe(true);
    expect(
      checks.get('sep-9998-list-changed-roster-updated')?.details?.untestable
    ).toBe(true);
  });
});
