/**
 * The specification links client checks cite.
 *
 * A check on a 2026-07-28 cell should cite the released 2026-07-28 text, and
 * every 2026-07-28 link should land on a page and heading that exist. The
 * pages and headings are recorded below rather than fetched, so the test
 * never touches the network.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { beforeAll, describe, expect, test } from 'vitest';
import { matchesSpecVersion, scenarios } from '../index';
import { testScenarioContext } from '../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION, type Scenario } from '../../types';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { setLogLevel } from '../../../examples/clients/typescript/helpers/logger';

const SPEC_SITE = 'https://modelcontextprotocol.io/specification/';
const RELEASE = `${SPEC_SITE}2026-07-28/`;
const DRAFT = `${SPEC_SITE}draft/`;

/**
 * Pages of the 2026-07-28 release and the heading anchors on each, recorded
 * from docs/specification/2026-07-28 in modelcontextprotocol/modelcontextprotocol
 * (tag 2026-07-28, 5f5440b; headings unchanged on main at 2997f33) and checked
 * against the ids on the published pages. A page path `p` is the source file
 * `p.mdx` or `p/index.mdx`; '' is the release's index page. The schema page's
 * anchors are not recorded: add them if a check starts citing one.
 */
const RELEASE_PAGES: Record<string, string> = {
  '': 'overview key-details base-protocol features additional-utilities extensions security-and-trust-&-safety key-principles implementation-guidelines learn-more',
  architecture:
    'core-components host clients servers design-principles capability-negotiation',
  basic:
    'messages requests responses result-responses error-responses error-codes notifications message-patterns statelessness auth schema json-schema-usage schema-dialect example-usage implementation-requirements schema-validation $ref-resolution composition-keyword-resource-use general-fields _meta icons',
  'basic/authorization':
    'introduction purpose-and-scope protocol-requirements standards-compliance roles overview authorization-server-discovery client-registration scope-selection-strategy authorization-flow-steps authorization-response-validation resource-parameter-implementation canonical-server-uri access-token-usage token-requirements token-handling refresh-tokens error-handling scope-challenge-handling runtime-insufficient-scope-errors step-up-authorization-flow security-considerations mcp-authorization-extensions',
  'basic/authorization/authorization-server-discovery':
    'authorization-server-location protected-resource-metadata-discovery-requirements authorization-server-metadata-discovery sequence-diagram',
  'basic/authorization/client-registration':
    'client-id-metadata-documents implementation-requirements example-metadata-document client-id-metadata-documents-flow advertising-cimd-support pre-registration dynamic-client-registration application-type-and-redirect-uri-constraints authorization-server-binding',
  'basic/authorization/security-considerations':
    'token-audience-binding-and-validation token-theft communication-security authorization-code-protection mix-up-attacks open-redirection client-id-metadata-document-security authorization-server-abuse-protection localhost-redirect-uri-risks trust-policies confused-deputy-problem access-token-privilege-restriction',
  'basic/patterns':
    'request-and-response multi-round-trip-requests subscribe-and-notify adding-patterns',
  'basic/patterns/cancellation':
    'cancellation-flow transport-specific-cancellation timeouts behavior-requirements timing-considerations implementation-notes error-handling',
  'basic/patterns/mrtr':
    'multi-round-trip-requests core-types inputrequests inputresponses inputrequiredresult supported-requests basic-workflow server-requirements-basic-workflow client-requirements-basic-workflow error-handling security-considerations',
  'basic/patterns/progress':
    'progress-flow behavior-requirements implementation-notes',
  'basic/patterns/subscriptions':
    'opening-a-stream notification-filter acknowledgment receiving-notifications multiple-concurrent-subscriptions cancellation graceful-closure',
  'basic/transports':
    'messages request-metadata cancellation custom-transports backward-compatibility',
  'basic/transports/stdio':
    'sending-messages receiving-messages request-metadata cancellation shutdown unexpected-termination backward-compatibility',
  'basic/transports/streamable-http':
    'security-&-endpoint sending-messages receiving-messages message-flow cancellation request-metadata protocol-version-header standard-request-headers custom-headers-from-tool-parameters schema-extension value-encoding client-behavior server-behavior-for-custom-headers case-sensitivity server-validation backward-compatibility earlier-streamable-http-revisions http+sse-transport-2024-11-05',
  'basic/versioning':
    'terminology protocol-version-negotiation extension-negotiation backward-compatibility-with-initialization-based-versions compatibility-matrix',
  changelog:
    'major-changes minor-changes deprecated other-schema-changes governance-and-process-updates process-changes full-changelog',
  'client/elicitation':
    'user-interaction-model capabilities protocol-messages elicitation-requests form-mode-elicitation-requests requested-schema example-simple-text-request example-structured-data-request url-mode-elicitation-requests example-request-sensitive-data message-flow form-mode-flow url-mode-flow response-actions implementation-considerations statefulness url-mode-elicitation-for-sensitive-data url-mode-elicitation-for-oauth-flows understanding-the-distinction implementation-pattern error-handling security-considerations safe-url-handling identifying-the-user form-mode-security phishing',
  'client/roots':
    'user-interaction-model capabilities protocol-messages listing-roots message-flow data-types root project-directory multiple-repositories error-handling security-considerations implementation-guidelines',
  'client/sampling':
    'user-interaction-model tools-in-sampling capabilities protocol-messages creating-messages sampling-with-tools multi-turn-tool-loop message-content-constraints tool-result-messages tool-use-and-result-balance cross-api-compatibility message-roles tool-choice-modes parallel-tool-use message-flow data-types messages text-content image-content audio-content model-preferences capability-priorities model-hints system-prompt context-inclusion sampling-parameters result-fields error-handling security-considerations',
  deprecated: 'deprecated removed',
  schema: '',
  server: '',
  'server/discover': 'request response when-to-call data-types discoverresult',
  'server/prompts':
    'user-interaction-model capabilities protocol-messages listing-prompts getting-a-prompt list-changed-notification message-flow data-types prompt promptmessage text-content image-content audio-content resource-links embedded-resources error-handling implementation-considerations security',
  'server/resources':
    'user-interaction-model capabilities protocol-messages listing-resources reading-resources resource-templates list-changed-notification subscriptions message-flow data-types resource resource-contents text-content binary-content annotations common-uri-schemes custom-uri-schemes error-handling security-considerations',
  'server/tools':
    'user-interaction-model capabilities protocol-messages listing-tools calling-tools input-required-tool-results list-changed-notification message-flow data-types tool tool-names x-mcp-header tool-result text-content image-content audio-content resource-links embedded-resources structured-content output-schema schema-examples tool-with-default-2020-12-schema tool-with-explicit-draft-07-schema tool-with-no-parameters stateful-tools error-handling security-considerations',
  'server/utilities/caching':
    'cacheable-results cache-key cacheable-model time-to-live-ttl-field freshness-calculation cache-scope-field choosing-a-cache-scope interaction-with-notifications interaction-with-pagination security-considerations',
  'server/utilities/completion':
    'user-interaction-model capabilities protocol-messages requesting-completions reference-types completion-results message-flow data-types completerequest completeresult error-handling implementation-considerations security',
  'server/utilities/logging':
    'user-interaction-model capabilities log-levels requesting-log-messages per-request-log-level protocol-messages log-message-notifications error-handling implementation-considerations security',
  'server/utilities/pagination':
    'pagination-model response-format request-format pagination-flow operations-supporting-pagination implementation-guidelines error-handling'
};

/** Why a 2026-07-28 URL does not resolve, or undefined when it does. */
function unresolved(url: string): string | undefined {
  const [path, anchor] = url.slice(RELEASE.length).split('#');
  const page = path.replace(/\/$/, '').replace(/(^|\/)index$/, '');
  const headings = RELEASE_PAGES[page];
  if (headings === undefined) return `no page ${page || '(index)'}`;
  if (anchor !== undefined && !headings.split(' ').includes(anchor)) {
    return `no heading #${anchor} on ${page || '(index)'}`;
  }
  return undefined;
}

describe('the recorded 2026-07-28 pages', () => {
  test('resolve the links the lookup is meant to accept and reject', () => {
    expect(unresolved(`${RELEASE}basic#_meta`)).toBeUndefined();
    expect(unresolved(`${RELEASE}basic/index#_meta`)).toBeUndefined();
    expect(unresolved(`${RELEASE}basic/utilities/mrtr`)).toBe(
      'no page basic/utilities/mrtr'
    );
    expect(unresolved(`${RELEASE}basic#meta`)).toBe(
      'no heading #meta on basic'
    );
  });
});

describe('specification links in the client scenario sources', () => {
  const root = __dirname;
  const sources = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(root, f));
  const links = sources.flatMap((file) =>
    [
      ...readFileSync(file, 'utf8').matchAll(
        /https:\/\/modelcontextprotocol\.io\/specification\/[^\s'"`)]+/g
      )
    ].map((m) => ({ file: relative(root, file), url: m[0] }))
  );

  test('every 2026-07-28 link names a recorded page and heading', () => {
    const release = links.filter((l) => l.url.startsWith(RELEASE));
    expect(release.length).toBeGreaterThan(0);
    const broken = release
      .map((l) => ({ ...l, why: unresolved(l.url) }))
      .filter((l) => l.why !== undefined);
    expect(broken).toEqual([]);
  });

  // The draft's wire version is still the released 2026-07-28, so whatever a
  // client scenario tests is in a released revision and should link to it.
  // Revisit once the draft moves past 2026-07-28.
  test.runIf(DRAFT_PROTOCOL_VERSION === '2026-07-28')(
    'no link points at the draft specification',
    () => {
      expect(links.filter((l) => l.url.startsWith(DRAFT))).toEqual([]);
    }
  );
});

/**
 * Every scenario on the 2026-07-28 column: those whose window covers
 * 2026-07-28, and the extensions, which run there unscored.
 */
function releaseScenarios(): Scenario[] {
  return [...scenarios.values()].filter(
    (s) =>
      'extensionId' in s.source ||
      matchesSpecVersion(s.source, DRAFT_PROTOCOL_VERSION)
  );
}

describe('checks emitted at 2026-07-28', () => {
  beforeAll(() => {
    setLogLevel('error');
  });

  for (const registered of releaseScenarios()) {
    test(`${registered.name} cites the 2026-07-28 release`, async () => {
      const scenario = registered.fresh?.() ?? registered;
      const ctx = testScenarioContext(DRAFT_PROTOCOL_VERSION);
      const urls = await scenario.start(ctx);
      process.env.MCP_CONFORMANCE_SCENARIO = registered.name;
      process.env.MCP_CONFORMANCE_PROTOCOL_VERSION = ctx.specVersion;
      process.env.MCP_CONFORMANCE_CONTEXT = JSON.stringify({
        name: registered.name,
        ...urls.context
      });
      try {
        // Outcomes are not the point here, only what the checks cite; some
        // scenarios expect the client to give up.
        await getHandler(registered.name)?.(urls.serverUrl);
      } catch {
        // ignored: see above
      }
      const checks = scenario.getChecks();
      await scenario.stop();

      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        const spec = (check.specReferences ?? [])
          .map((r) => r.url ?? '')
          .filter((u) => u.startsWith(SPEC_SITE));
        if (spec.length === 0) continue;
        // A check that cites the MCP specification at all cites 2026-07-28,
        // never the draft, and only pages and headings that exist.
        expect(
          spec.some((u) => u.startsWith(RELEASE)),
          `${check.id} cites ${spec.join(', ')}`
        ).toBe(true);
        expect(spec.filter((u) => u.startsWith(DRAFT))).toEqual([]);
        expect(
          spec
            .filter((u) => u.startsWith(RELEASE))
            .map(unresolved)
            .filter(Boolean)
        ).toEqual([]);
      }
    });
  }
});
