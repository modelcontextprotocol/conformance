/**
 * SEP-2640 client scenarios for what a host loads, refuses, and reads from
 * which server. The harness is the server, and every scenario grades the
 * requests the client sends.
 *
 * Each contract tells the client to try something, and the client library is
 * what must refuse it. A client that loads an invalid entry, or reads a file a
 * directory listed but the entry did not, sends a request the scenario sees.
 * That separates these from the retired `unlisted` variant in verification.ts:
 * there the driver was told not to ask, so only the driver was under test.
 *
 * Absence of a request proves something only once the client has done the
 * work around it, so every scenario requires a prerequisite request and
 * reports untestable without it (#248).
 */

import { ConformanceCheck, ScenarioUrls, Scenario } from '../../../types.js';
import type { ScenarioContext } from '../../../mock-server';
import { untestableCheck } from '../../untestable.js';
import {
  SKILLS_EXTENSION_ID,
  SkillsMockHost,
  entryFor,
  skillMd
} from './mock-host.js';

const SPEC_URL =
  'https://skills.extensions.modelcontextprotocol.io/specification/beta/skills';

function ref(anchor: string) {
  return { id: `SEP-2640-${anchor}`, url: `${SPEC_URL}#${anchor}` };
}

function check(
  id: string,
  description: string,
  anchor: string,
  violation: string | undefined,
  details: Record<string, unknown>
): ConformanceCheck {
  return {
    id,
    name: id,
    description,
    status: violation ? 'FAILURE' : 'SUCCESS',
    timestamp: new Date().toISOString(),
    errorMessage: violation,
    specReferences: [ref(anchor)],
    details
  };
}

function untestable(
  id: string,
  description: string,
  anchor: string,
  reason: string
): ConformanceCheck {
  return untestableCheck(id, id, description, reason, [ref(anchor)]);
}

/** A scenario backed by one SkillsMockHost, plus optional context. */
abstract class OneHostScenario implements Scenario {
  abstract name: string;
  abstract description: string;
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  allowClientError = true;
  protected abstract host: SkillsMockHost;
  protected context(): Record<string, unknown> | undefined {
    return undefined;
  }

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    const urls = await this.host.start(ctx);
    const context = this.context();
    return context ? { ...urls, context } : urls;
  }

  async stop(): Promise<void> {
    await this.host.stop();
  }

  abstract getChecks(): ConformanceCheck[];
}

// --- load by URI after an empty listing -------------------------------------

const BY_URI = 'skill://pdf-processing/SKILL.md';
const BY_URI_FILES = { [BY_URI]: skillMd('pdf-processing') };

/**
 * `skills/list` answers an empty listing, and `skills/get` resolves one skill
 * the scenario names in `MCP_CONFORMANCE_CONTEXT` as `skillUri`.
 *
 * Contract: call `skills/list`, then load the skill at `skillUri` by its URI
 * (`skills/get`, then read its SKILL.md), then exit.
 */
export class SkillsLoadByUriScenario extends OneHostScenario {
  name = 'sep-2640-client-load-by-uri';
  description =
    'A host MUST support loading a skill given only its URI, and MUST NOT treat an empty listing as proof that a server has no skills.';
  protected host = new SkillsMockHost(this.name, {
    listed: [],
    gettable: [entryFor(BY_URI, 'pdf-processing', BY_URI_FILES)],
    files: BY_URI_FILES
  });

  protected context() {
    return { skillUri: BY_URI };
  }

  getChecks(): ConformanceCheck[] {
    const listIdx = this.host.requests.findIndex(
      (r) => r.method === 'skills/list'
    );
    const loadIdx = this.host.requests.findIndex(
      (r) =>
        (r.method === 'skills/get' || r.method === 'resources/read') &&
        r.uri === BY_URI
    );
    const got = this.host.called('skills/get', BY_URI);
    const read = this.host.called('resources/read', BY_URI);
    const details = { requests: this.host.requests };

    const emptyText =
      'Hosts MUST NOT treat an empty or partial listing as proof that a server has no skills.';
    const empty =
      listIdx < 0
        ? untestable(
            'sep-2640-host-no-empty-listing-assumption',
            emptyText,
            'listing-skills',
            'the client never called skills/list, so it never saw the empty listing'
          )
        : check(
            'sep-2640-host-no-empty-listing-assumption',
            emptyText,
            'listing-skills',
            loadIdx > listIdx
              ? undefined
              : `the client got an empty skills/list and never asked for ${BY_URI}, which the server serves`,
            details
          );

    const byUriText =
      'Hosts MUST support loading a skill given only its URI: skills/get resolves the entry, and the SKILL.md is read against it.';
    const byUri = check(
      'sep-2640-host-load-by-uri',
      byUriText,
      'listing-skills',
      got && read
        ? undefined
        : !got
          ? `the client never called skills/get for ${BY_URI}`
          : `the client resolved ${BY_URI} with skills/get but never read the SKILL.md`,
      details
    );
    return [empty, byUri];
  }
}

// --- invalid entries are not loaded -----------------------------------------

const VALID = 'skill://pdf-processing/SKILL.md';
const NO_RESOURCES = 'skill://no-manifest/SKILL.md';
const BAD_RESOURCES = 'skill://bad-manifest/SKILL.md';

/**
 * `skills/list` answers one valid entry and two invalid ones: one with no
 * `resources`, and one whose `resources` is neither an array nor "dynamic".
 * The server still serves all three SKILL.md files.
 *
 * Contract: call `skills/list`, then load every listed skill, then exit.
 */
export class SkillsInvalidEntryScenario extends OneHostScenario {
  name = 'sep-2640-client-invalid-entry';
  description =
    'An entry with no resources, or with resources neither an array nor "dynamic", is invalid, and hosts MUST NOT load it.';
  protected host = (() => {
    const files = {
      [VALID]: skillMd('pdf-processing'),
      [NO_RESOURCES]: skillMd('no-manifest'),
      [BAD_RESOURCES]: skillMd('bad-manifest')
    };
    const noResources = entryFor(NO_RESOURCES, 'no-manifest', {});
    delete noResources.resources;
    return new SkillsMockHost(this.name, {
      listed: [
        entryFor(VALID, 'pdf-processing', { [VALID]: files[VALID] }),
        noResources,
        { ...entryFor(BAD_RESOURCES, 'bad-manifest', {}), resources: 'all' }
      ],
      files
    });
  })();

  getChecks(): ConformanceCheck[] {
    const id = 'sep-2640-resources-invalid-entry';
    const text = this.description;
    if (!this.host.called('resources/read', VALID)) {
      return [
        untestable(
          id,
          text,
          'resources',
          `the client never loaded ${VALID}, the valid entry, so not loading the invalid ones proves nothing`
        )
      ];
    }
    const loaded = [NO_RESOURCES, BAD_RESOURCES].filter((u) =>
      this.host.called('resources/read', u)
    );
    return [
      check(
        id,
        text,
        'resources',
        loaded.length
          ? `the client loaded ${loaded.join(' and ')}, whose entries are invalid`
          : undefined,
        { reads: this.host.reads() }
      )
    ];
  }
}

// --- a directory listing does not extend the manifest -----------------------

const DIR_SKILL = 'skill://pdf-processing/SKILL.md';
const DIR_LISTED = 'skill://pdf-processing/references/FORMS.md';
const DIR_EXTRA = 'skill://pdf-processing/references/EXTRA.md';

/**
 * The entry lists SKILL.md and references/FORMS.md. `resources/directory/read`
 * of references/ lists FORMS.md and EXTRA.md, and the server serves both.
 *
 * Contract: call `skills/list`, load the skill, walk its directory with
 * `resources/directory/read` from the skill root, and read every file the
 * directory lists through the held entry. Then exit.
 */
export class SkillsDirectoryUnlistedChildScenario extends OneHostScenario {
  name = 'sep-2640-client-directory-unlisted-child';
  description =
    'Hosts MUST NOT treat a directory result as extending the manifest, and MUST NOT read a child the entry does not list.';
  protected host = (() => {
    const files = {
      [DIR_SKILL]: skillMd('pdf-processing'),
      [DIR_LISTED]: 'Listed supporting file.\n',
      [DIR_EXTRA]: 'A file the entry does not list.\n'
    };
    return new SkillsMockHost(this.name, {
      listed: [
        entryFor(DIR_SKILL, 'pdf-processing', {
          [DIR_SKILL]: files[DIR_SKILL],
          [DIR_LISTED]: files[DIR_LISTED]
        })
      ],
      files,
      dirs: {
        'skill://pdf-processing': [
          { uri: DIR_SKILL, name: 'SKILL.md', mimeType: 'text/markdown' },
          {
            uri: 'skill://pdf-processing/references',
            name: 'references',
            mimeType: 'inode/directory'
          }
        ],
        'skill://pdf-processing/references': [
          { uri: DIR_LISTED, name: 'FORMS.md', mimeType: 'text/markdown' },
          { uri: DIR_EXTRA, name: 'EXTRA.md', mimeType: 'text/markdown' }
        ]
      }
    });
  })();

  getChecks(): ConformanceCheck[] {
    const id = 'sep-2640-directory-read-not-manifest-extension';
    const anchor = 'directory-reads-and-the-held-entry';
    if (
      !this.host.called(
        'resources/directory/read',
        'skill://pdf-processing/references'
      ) ||
      !this.host.called('resources/read', DIR_LISTED)
    ) {
      return [
        untestable(
          id,
          this.description,
          anchor,
          `the client did not read references/ and then ${DIR_LISTED}, so it never reached the unlisted child`
        )
      ];
    }
    return [
      check(
        id,
        this.description,
        anchor,
        this.host.called('resources/read', DIR_EXTRA)
          ? `the client read ${DIR_EXTRA}, which the directory listed and the entry did not`
          : undefined,
        { reads: this.host.reads() }
      )
    ];
  }
}

// --- two servers ------------------------------------------------------------

const SHARED = 'skill://shared/SKILL.md';
const A_ONLY_FILE = 'skill://shared/references/A.md';
const B_ONLY_FILE = 'skill://shared/references/B.md';
const A_PDF = 'skill://pdf/SKILL.md';
const B_PDF = 'skill://acme/pdf/SKILL.md';

function twoOriginHost(name: string, side: 'A' | 'B'): SkillsMockHost {
  const shared = skillMd('shared', `Served by server ${side}.`);
  const own = side === 'A' ? A_ONLY_FILE : B_ONLY_FILE;
  const pdfUri = side === 'A' ? A_PDF : B_PDF;
  const pdf = skillMd('pdf', `The pdf skill on server ${side}.`);
  const sharedFiles = { [SHARED]: shared, [own]: `Only on ${side}.\n` };
  return new SkillsMockHost(`${name}-${side}`, {
    listed: [
      entryFor(SHARED, 'shared', sharedFiles),
      entryFor(pdfUri, 'pdf', { [pdfUri]: pdf })
    ],
    files: { ...sharedFiles, [pdfUri]: pdf }
  });
}

/**
 * Two servers. Both serve skill://shared/SKILL.md, with different bodies and
 * a supporting file only that server has. Each also serves a skill named
 * `pdf`, at skill://pdf/SKILL.md on A and skill://acme/pdf/SKILL.md on B.
 * Server A is `serverUrl`, and server B arrives in `MCP_CONFORMANCE_CONTEXT`
 * as `secondServerUrl`.
 *
 * Contract: connect to both, call `skills/list` on each, and load every
 * listed skill from the server that listed it, reading every file its entry
 * lists. Then exit.
 */
export class SkillsTwoOriginsScenario implements Scenario {
  name = 'sep-2640-client-two-origins';
  description =
    "A skill's identity is the pair of its server and its uri. Reads stay on the originating server, and a same-named skill on another server is not shadowed.";
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  allowClientError = true;
  private a = twoOriginHost(this.name, 'A');
  private b = twoOriginHost(this.name, 'B');

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    const a = await this.a.start(ctx);
    const b = await this.b.start(ctx);
    return {
      serverUrl: a.serverUrl,
      context: { secondServerUrl: b.serverUrl }
    };
  }

  async stop(): Promise<void> {
    await Promise.all([this.a.stop(), this.b.stop()]);
  }

  getChecks(): ConformanceCheck[] {
    const ids: Array<[string, string, string]> = [
      [
        'sep-2640-host-skill-identity-pair',
        'skill-uris',
        'The identity of an MCP-served skill is the pair of the server and the uri; hosts MUST NOT key it on the uri alone.'
      ],
      [
        'sep-2640-host-cross-origin-no-shadow',
        'names',
        'An MCP-served skill MUST NOT silently shadow, or be substituted for, a same-named skill from another origin.'
      ],
      [
        'sep-2640-host-reads-bound-to-origin',
        'security-considerations',
        "Hosts MUST bind reads to the skill's originating server. A skill served by A MUST NOT cause a resources/read against B."
      ]
    ];
    if (!this.a.called('skills/list') || !this.b.called('skills/list')) {
      return ids.map(([id, anchor, text]) =>
        untestable(
          id,
          text,
          anchor,
          'the client did not call skills/list on both servers, so it never held skills from two origins'
        )
      );
    }
    const details = { readsA: this.a.reads(), readsB: this.b.reads() };
    const identity =
      this.a.called('resources/read', SHARED) &&
      this.b.called('resources/read', SHARED)
        ? undefined
        : `${SHARED} was read from ${this.a.called('resources/read', SHARED) ? 'server A only' : this.b.called('resources/read', SHARED) ? 'server B only' : 'neither server'}; both serve their own skill at that uri`;
    const shadow =
      this.a.called('resources/read', A_PDF) &&
      this.b.called('resources/read', B_PDF)
        ? undefined
        : `both servers list a skill named pdf, and the client loaded ${
            [
              this.a.called('resources/read', A_PDF) && 'A’s',
              this.b.called('resources/read', B_PDF) && 'B’s'
            ]
              .filter(Boolean)
              .join(' and ') || 'neither'
          }`;
    const strays = [
      ...this.a
        .reads()
        .filter((u) => u === B_ONLY_FILE || u === B_PDF)
        .map((u) => `server A got a read of ${u}, which only B lists`),
      ...this.b
        .reads()
        .filter((u) => u === A_ONLY_FILE || u === A_PDF)
        .map((u) => `server B got a read of ${u}, which only A lists`)
    ];
    return [
      check(ids[0][0], ids[0][2], ids[0][1], identity, details),
      check(ids[1][0], ids[1][2], ids[1][1], shadow, details),
      check(
        ids[2][0],
        ids[2][2],
        ids[2][1],
        strays.length ? strays.join('; ') : undefined,
        details
      )
    ];
  }
}
