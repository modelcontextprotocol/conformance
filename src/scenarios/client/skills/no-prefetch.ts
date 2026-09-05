/**
 * SEP-2640 client scenario: hosts MUST NOT retrieve a skill's files ahead of
 * need.
 *
 * This is a `Scenario` rather than a `ClientScenario`: the harness stands up
 * the server and the client is the system under test. The rule reduces to
 * "did a request arrive", which makes it one of the most wire-observable
 * obligations in the SEP despite the first traceability pass filing it as an
 * unobservable host obligation.
 *
 * Contract for the client under test, keyed on MCP_CONFORMANCE_SCENARIO:
 * connect, call `skills/list`, then exit. Do not load a skill. A client that
 * prefetches will read `SKILL.md` or a supporting file during that window and
 * fail the check.
 */

import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import { BaseHttpScenario } from '../http-base.js';

const SPEC_REFERENCE = {
  id: 'SEP-2640-Lazy-Retrieval',
  url: 'https://modelcontextprotocol.io/seps/2640-skills-extension#integrity-and-verification'
};

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** One skill with a supporting file, so a prefetch has something to grab. */
const SKILL_URI = 'skill://pdf-processing/SKILL.md';
const SUPPORTING_URI = 'skill://pdf-processing/references/FORMS.md';

const SKILL_MD = `---
name: pdf-processing
description: Extract, fill, and assemble PDF documents
---

Body the client has no business fetching yet.
`;

const SUPPORTING =
  'Supporting content the client has no business fetching yet.\n';

/** sha256 of the two bodies, computed at module load so the entry is honest. */
import { createHash } from 'crypto';
const digestOf = (s: string) =>
  'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

export class SkillsNoPrefetchScenario extends BaseHttpScenario {
  name = 'sep-2640-client-no-prefetch';
  description =
    'A client MUST NOT retrieve a skill file before the skill is loaded';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;

  /** Every resources/read URI the client asked for, in order. */
  private readsRequested: string[] = [];
  private listCalled = false;

  protected handlePost(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    switch (request.method) {
      case 'initialize':
        this.sendInitialize(res, request, {
          resources: { listChanged: false },
          extensions: { [SKILLS_EXTENSION_ID]: {} }
        });
        return;

      case 'skills/list':
        this.listCalled = true;
        this.sendJson(res, {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            resultType: 'complete',
            skills: [
              {
                uri: SKILL_URI,
                frontmatter: {
                  name: 'pdf-processing',
                  description: 'Extract, fill, and assemble PDF documents'
                },
                resources: [
                  {
                    uri: SKILL_URI,
                    digest: digestOf(SKILL_MD),
                    size: Buffer.byteLength(SKILL_MD)
                  },
                  {
                    uri: SUPPORTING_URI,
                    digest: digestOf(SUPPORTING),
                    size: Buffer.byteLength(SUPPORTING)
                  }
                ]
              }
            ]
          }
        });
        return;

      // Served, but reaching it during this scenario is the failure.
      case 'resources/read': {
        const uri = request.params?.uri;
        if (typeof uri === 'string') this.readsRequested.push(uri);
        const body = uri === SUPPORTING_URI ? SUPPORTING : SKILL_MD;
        this.sendJson(res, {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            resultType: 'complete',
            contents: [{ uri, mimeType: 'text/markdown', text: body }]
          }
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

  getChecks(): ConformanceCheck[] {
    const DESC =
      "Hosts MUST NOT retrieve a skill's files ahead of need, not on connection, not on listing, and not at approval.";

    // Without a listing there is no window in which prefetching is even
    // possible, so the run proves nothing rather than passing.
    if (!this.listCalled) {
      return [
        {
          id: 'sep-2640-host-no-prefetch',
          name: 'SkillsClientNoPrefetch',
          description: DESC,
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage:
            'the client never called skills/list, so no retrieval window was opened',
          specReferences: [SPEC_REFERENCE]
        }
      ];
    }

    const prefetched = this.readsRequested.filter(
      (u) => u === SKILL_URI || u === SUPPORTING_URI
    );

    return [
      {
        id: 'sep-2640-host-no-prefetch',
        name: 'SkillsClientNoPrefetch',
        description: DESC,
        status: prefetched.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          prefetched.length === 0
            ? undefined
            : `client read ${prefetched.length} skill file(s) without loading a skill: ${prefetched.join(', ')}`,
        specReferences: [SPEC_REFERENCE],
        details: {
          skillsListCalled: true,
          fileReads: prefetched.length
        }
      }
    ];
  }
}
