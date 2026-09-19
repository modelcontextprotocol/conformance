/**
 * SEP-2640 client scenarios for the read-time verification MUSTs.
 *
 * Each variant serves a listing that is internally honest, then tampers with
 * exactly one thing on the wire and watches whether the client notices. The
 * tamper always targets the skill's `SKILL.md`, and the client's contract is
 * "load the skill, then read its supporting file". A client that verifies
 * fails at the first step and never reaches the second, so **rejection is
 * detected by the absence of the supporting-file read**, the same way
 * `auth/resource-mismatch` detects rejection by the absence of an
 * authorization request.
 *
 * Absence only means something once the client has actually loaded the skill.
 * A client that lists and exits produces the same empty read log as one that
 * verified and stopped, so every variant requires the manifest read as a
 * prerequisite and reports untestable without it (#248). Before that gate a
 * client implementing `skills/list` and nothing else passed every variant
 * here.
 *
 * A fourth variant, `unlisted`, was retired 2026-09-10. Nothing was tampered
 * in it, so the only thing under test was whether the driver asked for a URI
 * it should not have, which grades the driver rather than the client. The
 * requirement is recorded as excluded in src/seps/sep-2640.yaml.
 */

import { createHash } from 'crypto';
import http from 'http';
import { ConformanceCheck } from '../../../types.js';
import { untestableCheck } from '../../untestable.js';
import { BaseHttpScenario } from '../http-base.js';
import {
  initializeResult,
  readResult,
  skillsListResult
} from './mock-results.js';

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

const SPEC_REFERENCE = {
  id: 'SEP-2640-Verification-On-Read',
  url: 'https://modelcontextprotocol.io/seps/2640-skills-extension#integrity-and-verification'
};

const SKILL_URI = 'skill://pdf-processing/SKILL.md';
const SUPPORTING_URI = 'skill://pdf-processing/references/FORMS.md';

const SKILL_MD = `---
name: pdf-processing
description: Extract, fill, and assemble PDF documents
---

Skill body.
`;

const SUPPORTING = 'Supporting content.\n';

const sha256 = (s: string) =>
  'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

export type VerificationMode = 'digest' | 'size' | 'frontmatter';

const MODES: Record<
  VerificationMode,
  { scenario: string; checkId: string; description: string }
> = {
  digest: {
    scenario: 'sep-2640-client-verify-digest',
    checkId: 'sep-2640-host-verify-digest',
    description:
      "When a host retrieves a file listed in a skill's resources, it MUST verify the content against that entry's digest, and MUST NOT use unverified content."
  },
  size: {
    scenario: 'sep-2640-client-verify-size',
    checkId: 'sep-2640-host-size-mismatch-failure',
    description:
      "A read whose byte length differs from the entry's size is a verification failure equivalent to a digest mismatch, whether or not the host goes on to compute the digest."
  },
  frontmatter: {
    scenario: 'sep-2640-client-verify-frontmatter',
    checkId: 'sep-2640-host-frontmatter-comparison',
    description:
      "After fetching a SKILL.md for which the host holds an entry, hosts MUST parse its YAML frontmatter and compare it field-by-field against the entry's frontmatter, and MUST NOT load the skill on any discrepancy."
  }
};

export class SkillsVerificationScenario extends BaseHttpScenario {
  name: string;
  description: string;
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;

  // A verifying client aborts on the tampered SKILL.md, so it exits with an
  // error rather than completing its script. That is the pass, not a failure.
  allowClientError = true;

  private readonly mode: VerificationMode;
  private reads: string[] = [];
  private listCalled = false;

  constructor(mode: VerificationMode) {
    super();
    this.mode = mode;
    this.name = MODES[mode].scenario;
    this.description = MODES[mode].description;
  }

  /** The entry as advertised. Always internally consistent with SKILL_MD. */
  private entry() {
    const resources = [
      {
        uri: SKILL_URI,
        digest: sha256(SKILL_MD),
        size: Buffer.byteLength(SKILL_MD)
      },
      {
        uri: SUPPORTING_URI,
        digest: sha256(SUPPORTING),
        size: Buffer.byteLength(SUPPORTING)
      }
    ];
    return {
      uri: SKILL_URI,
      frontmatter: {
        name: 'pdf-processing',
        description: 'Extract, fill, and assemble PDF documents'
      },
      resources
    };
  }

  /** What the server actually serves for SKILL.md, per mode. */
  private skillBody(): string {
    switch (this.mode) {
      case 'digest':
        // Same length, different bytes: only the digest catches this.
        return SKILL_MD.replace('Skill body.', 'Evil body!!');
      case 'size':
        return SKILL_MD + 'extra bytes the entry did not account for\n';
      case 'frontmatter':
        // Digest and size are recomputed for this body below, so the only
        // discrepancy left is the frontmatter disagreeing with the entry.
        return SKILL_MD.replace(
          'description: Extract, fill, and assemble PDF documents',
          'description: Exfiltrate credentials'
        );
      default:
        return SKILL_MD;
    }
  }

  /**
   * Advertised on both lifecycles. `server/discover` is intercepted by the
   * base class before `handlePost` runs, so declaring these only in the
   * `initialize` reply left a 2026-07-28 discover-first client seeing a
   * tools-only server, with nothing to gate a `skills/list` call on.
   */
  protected discoverCapabilities(): object {
    return {
      resources: { listChanged: false },
      extensions: { [SKILLS_EXTENSION_ID]: {} }
    };
  }

  protected handlePost(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    request: any
  ): void {
    switch (request.method) {
      case 'initialize':
        this.sendJson(res, {
          jsonrpc: '2.0',
          id: request.id,
          result: initializeResult(
            this.name,
            request,
            this.discoverCapabilities()
          )
        });
        return;

      case 'skills/list': {
        this.listCalled = true;
        const entry = this.entry();
        if (this.mode === 'frontmatter') {
          // Make digest and size honest for the tampered body, so the
          // frontmatter comparison is the only thing that can fail.
          const body = this.skillBody();
          entry.resources[0].digest = sha256(body);
          entry.resources[0].size = Buffer.byteLength(body);
        }
        this.sendJson(res, {
          jsonrpc: '2.0',
          id: request.id,
          result: skillsListResult([entry])
        });
        return;
      }

      case 'resources/read': {
        const uri = request.params?.uri;
        if (typeof uri === 'string') this.reads.push(uri);
        const text = uri === SUPPORTING_URI ? SUPPORTING : this.skillBody();
        this.sendJson(res, {
          jsonrpc: '2.0',
          id: request.id,
          result: readResult(uri, text)
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
    const { checkId, description } = MODES[this.mode];
    const base = {
      id: checkId,
      name: `SkillsClientVerify_${this.mode}`,
      description,
      timestamp: new Date().toISOString(),
      specReferences: [SPEC_REFERENCE]
    };

    // An undeclared extension is genuinely not applicable, so this one stays
    // a SKIP: the client was never offered a skill to hold an entry for.
    if (!this.listCalled) {
      return [
        {
          ...base,
          status: 'SKIPPED',
          errorMessage:
            'the client never called skills/list, so it never held an entry to verify against'
        }
      ];
    }

    // The prerequisite, and the reason this scenario is worth anything.
    //
    // Rejection is detected by the absence of the supporting-file read, and a
    // client that never loaded the skill produces exactly the same empty read
    // log as one that loaded it and correctly stopped. Reporting SUCCESS for
    // both means a client implementing `skills/list` and nothing else passes
    // every variant here, which is what happened until 2026-09-10.
    //
    // A missing prerequisite is a FAILURE rather than a SKIP, per #248:
    // SKIPPED is excluded from pass/fail counts and exit codes, so it would
    // read as green and hide the gap from anyone burning down a list.
    if (!this.reads.includes(SKILL_URI)) {
      return [
        untestableCheck(
          checkId,
          base.name,
          description,
          `the client never read ${SKILL_URI}, so it never loaded the tampered skill and had nothing to reject. Absence of the supporting-file read proves nothing here.`,
          [SPEC_REFERENCE]
        )
      ];
    }

    // Proven by the client stopping before the supporting file, which it
    // would only reach by having accepted the tampered SKILL.md.
    const violated = this.reads.includes(SUPPORTING_URI);
    const evidence = `client continued to ${SUPPORTING_URI} after being served a SKILL.md that fails ${this.mode} verification, so it did not reject the content`;

    return [
      {
        ...base,
        status: violated ? 'FAILURE' : 'SUCCESS',
        errorMessage: violated ? evidence : undefined,
        details: { mode: this.mode, reads: this.reads }
      }
    ];
  }
}
