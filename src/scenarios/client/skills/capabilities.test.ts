import { describe, test, expect } from 'vitest';
import { testScenarioContext } from '../../../mock-server/testing';
import { sendStatelessRequest } from '../../../connection/stateless';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { SkillsNoPrefetchScenario } from './no-prefetch';
import { SkillsVerificationScenario } from './verification';

/**
 * Regression for PR #330 review: both skills client scenarios declared the
 * skills extension only in their `initialize` reply, but `BaseHttpScenario`
 * intercepts `server/discover` before `handlePost` runs. A 2026-07-28
 * discover-first client therefore saw the base class default (`{tools: {}}`)
 * and had nothing to gate a `skills/list` call on.
 *
 * The scenarios passed anyway because `server/discover` is optional for
 * clients and the clients we ran did not use it. That is exactly the failure
 * mode where a check goes green because its condition never arose, so both
 * lifecycles are asserted here rather than left to the next client to notice.
 */

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

type Caps = {
  resources?: unknown;
  extensions?: Record<string, unknown>;
};

function capsOf(result: unknown): Caps {
  return ((result as { capabilities?: Caps })?.capabilities ?? {}) as Caps;
}

function expectSkillsAdvertised(caps: Caps, where: string): void {
  expect(caps.extensions, `${where}: no extensions block`).toBeDefined();
  expect(
    caps.extensions?.[SKILLS_EXTENSION_ID],
    `${where}: skills extension not advertised`
  ).toBeDefined();
  // resources/read is how every skill file is fetched, so a client that gates
  // on capabilities needs this too.
  expect(caps.resources, `${where}: resources not advertised`).toBeDefined();
}

const SCENARIOS: Array<
  [string, () => SkillsNoPrefetchScenario | SkillsVerificationScenario]
> = [
  ['no-prefetch', () => new SkillsNoPrefetchScenario()],
  ['verify-digest', () => new SkillsVerificationScenario('digest')],
  ['verify-size', () => new SkillsVerificationScenario('size')],
  ['verify-frontmatter', () => new SkillsVerificationScenario('frontmatter')],
  ['verify-unlisted', () => new SkillsVerificationScenario('unlisted')]
];

describe('SEP-2640 client scenarios advertise skills on both lifecycles', () => {
  test.each(SCENARIOS)('%s: server/discover', async (label, make) => {
    const scenario = make();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const discover = await sendStatelessRequest(serverUrl, 'server/discover');
      expect(discover.status).toBe(200);
      expectSkillsAdvertised(
        capsOf(discover.body?.result),
        `${label} discover`
      );
    } finally {
      await scenario.stop();
    }
  });

  test.each(SCENARIOS)('%s: initialize', async (label, make) => {
    const scenario = make();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const init = await sendStatelessRequest(serverUrl, 'initialize', {
        protocolVersion: DRAFT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'capabilities-test', version: '1.0.0' }
      });
      expect(init.status).toBe(200);
      expectSkillsAdvertised(capsOf(init.body?.result), `${label} initialize`);
    } finally {
      await scenario.stop();
    }
  });
});
