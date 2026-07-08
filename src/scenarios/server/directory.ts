/**
 * SEP-2640 Skills extension scenarios — focused on the resources/directory/read
 * surface added in spec commit 2e04c48d (2026-06-09).
 *
 * One scenario, six checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec quote lives next to its check ID in
 * src/seps/sep-2640.yaml, so the YAML and the scenario stay in lock-step.
 *
 * Capability discovery: the SEP allows multiple shapes for declaring the
 * extension; the wire-observable signal we can rely on is whether
 * resources/directory/read responds at all. A -32601 method-not-found is the
 * only definitive "server didn't declare directoryRead" signal; any other
 * response (success, -32602, etc.) means the server registered the method,
 * which the SEP requires of any server that declared the capability.
 *
 * Fixture assumption: the scenario expects the standard mcpkit examples/skills
 * fixture which exposes skill://acme/billing/refunds with a templates/
 * subtree containing at least one subdirectory. When the connected server is
 * not a skills server (no skill:// resources at all), every check is emitted
 * as SKIPPED — keeps the scenario green against the upstream everything-server
 * while emitting real verdicts against any skills-capable fixture.
 */

import { ClientScenario, ConformanceCheck } from '../../types';
import { JsonRpcError, type RunContext } from '../../connection';
import type { ListResourcesResult } from '../../spec-types/2025-06-18';

interface ResourceLike {
  uri: string;
  name?: string;
  mimeType?: string;
}

interface DirectoryReadResult {
  resources?: ResourceLike[];
  nextCursor?: string;
}

const SEP_2640_URL =
  'https://modelcontextprotocol.io/seps/2640-skills-extension#directory-listing';

const HAPPY_PATH_URI = 'skill://acme/billing/refunds/templates';
const NON_DIRECTORY_URI = 'skill://acme/billing/refunds/SKILL.md';

const SPEC_REFERENCE = [
  {
    id: 'SEP-2640-directory-listing',
    url: SEP_2640_URL
  }
];

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

function check(
  id: string,
  description: string,
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED',
  extras: Partial<ConformanceCheck> = {}
): ConformanceCheck {
  return {
    id,
    name: id,
    description,
    status,
    timestamp: new Date().toISOString(),
    specReferences: SPEC_REFERENCE,
    ...extras
  };
}

export class ResourcesDirectoryReadScenario implements ClientScenario {
  name = 'sep-2640-skills';
  readonly source = {
    extensionId: 'io.modelcontextprotocol/skills'
  } as const;
  description = `SEP-2640 Skills extension: resources/directory/read surface (added in spec commit 2e04c48d, 2026-06-09).

**Endpoint**: \`resources/directory/read\` (gated by \`io.modelcontextprotocol/skills.directoryRead: true\`)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-2640.yaml):

- \`sep-2640-capability-directory-read-flag\` — server effectively declared directoryRead
- \`sep-2640-directory-read-method-registered\` — method registered for served skill directories
- \`sep-2640-directory-read-result-resources-shape\` — result has resources[] of direct children
- \`sep-2640-directory-read-subdir-mimetype\` — subdirectories surface with \`inode/directory\` mime
- \`sep-2640-directory-read-invalid-params\` — non-directory URI returns \`-32602\`
- \`sep-2640-directory-read-pagination\` — \`nextCursor\` round-trips per resources/list contract

**Fixture expectation**: the server exposes \`skill://acme/billing/refunds/templates\` with at least one subdirectory child. Without any \`skill://\` resources every check emits SKIPPED.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      // SKIP gate: if the server exposes no skill:// resources, treat the
      // run as not-applicable rather than failing every check.
      let resources: ResourceLike[] = [];
      try {
        const list = await conn.request<ListResourcesResult>('resources/list');
        resources = (list.resources ?? []) as ResourceLike[];
      } catch {
        // resources/list missing is itself diagnostic — the server can't be a
        // skills server. Fall through to the SKIP branch.
      }
      const hasSkills = resources.some((r) => r.uri.startsWith('skill://'));
      if (!hasSkills) {
        const reason =
          'Server exposes no skill:// resources; SEP-2640 directoryRead checks not applicable.';
        return [
          'sep-2640-capability-directory-read-flag',
          'sep-2640-directory-read-method-registered',
          'sep-2640-directory-read-result-resources-shape',
          'sep-2640-directory-read-subdir-mimetype',
          'sep-2640-directory-read-invalid-params',
          'sep-2640-directory-read-pagination'
        ].map((id) => check(id, reason, 'SKIPPED', { errorMessage: reason }));
      }

      const checks: ConformanceCheck[] = [];

      // === Happy path: list a known directory ===
      let happy: DirectoryReadResult | undefined;
      let happyErr: unknown;
      try {
        happy = await conn.request<DirectoryReadResult>(
          'resources/directory/read',
          { uri: HAPPY_PATH_URI }
        );
      } catch (e) {
        happyErr = e;
      }

      const isMethodNotFound =
        happyErr instanceof JsonRpcError &&
        happyErr.code === JSONRPC_METHOD_NOT_FOUND;

      // Check 1: capability declaration (derived from method registration).
      checks.push(
        check(
          'sep-2640-capability-directory-read-flag',
          'Server declared the directoryRead capability — derived from whether resources/directory/read is registered (a server that did not declare directoryRead would return -32601 method-not-found).',
          isMethodNotFound ? 'FAILURE' : 'SUCCESS',
          isMethodNotFound
            ? {
                errorMessage: `resources/directory/read returned -32601, implying the server did not declare directoryRead: ${
                  (happyErr as JsonRpcError).message
                }`
              }
            : {}
        )
      );

      // Check 2: method registered.
      checks.push(
        check(
          'sep-2640-directory-read-method-registered',
          'resources/directory/read accepts a call against a known skill subdirectory.',
          happy !== undefined
            ? 'SUCCESS'
            : isMethodNotFound
              ? 'FAILURE'
              : 'FAILURE',
          happy !== undefined
            ? { details: { uri: HAPPY_PATH_URI } }
            : {
                errorMessage:
                  happyErr instanceof Error
                    ? happyErr.message
                    : String(happyErr)
              }
        )
      );

      // Check 3: result shape — resources[] of Resource objects.
      const shapeOk = Array.isArray(happy?.resources);
      const shapeErrs: string[] = [];
      if (!shapeOk) {
        shapeErrs.push('result.resources is not an array');
      } else {
        happy!.resources!.forEach((r, i) => {
          if (typeof r.uri !== 'string')
            shapeErrs.push(`resources[${i}].uri is not a string`);
        });
      }
      checks.push(
        check(
          'sep-2640-directory-read-result-resources-shape',
          'Result carries resources[] whose entries match the Resource shape (uri at minimum) from resources/list.',
          shapeErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
          shapeErrs.length > 0
            ? { errorMessage: shapeErrs.join('; ') }
            : { details: { entryCount: happy?.resources?.length ?? 0 } }
        )
      );

      // Check 4: subdirectory mime marker.
      const subdirChild = happy?.resources?.find(
        (r) => r.mimeType === 'inode/directory'
      );
      const hasSubdir = subdirChild !== undefined;
      checks.push(
        check(
          'sep-2640-directory-read-subdir-mimetype',
          'Subdirectory child carries mimeType "inode/directory" so clients can descend.',
          hasSubdir ? 'SUCCESS' : 'FAILURE',
          hasSubdir
            ? { details: { subdirectoryUri: subdirChild!.uri } }
            : {
                errorMessage:
                  'Expected at least one child with mimeType "inode/directory" under ' +
                  HAPPY_PATH_URI +
                  '. Server fixture should expose a subdirectory there.'
              }
        )
      );

      // === Error path: non-directory URI ===
      let invalidParamsOk = false;
      let invalidParamsDetail = '';
      try {
        await conn.request<DirectoryReadResult>('resources/directory/read', {
          uri: NON_DIRECTORY_URI
        });
        invalidParamsDetail =
          'expected -32602 for non-directory URI, got success';
      } catch (e) {
        if (e instanceof JsonRpcError && e.code === JSONRPC_INVALID_PARAMS) {
          invalidParamsOk = true;
        } else if (e instanceof JsonRpcError) {
          invalidParamsDetail = `expected -32602 for non-directory URI, got ${e.code}: ${e.message}`;
        } else {
          invalidParamsDetail = `expected -32602, got non-JsonRpcError: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
      checks.push(
        check(
          'sep-2640-directory-read-invalid-params',
          'Non-directory URI yields -32602 Invalid params.',
          invalidParamsOk ? 'SUCCESS' : 'FAILURE',
          invalidParamsOk ? {} : { errorMessage: invalidParamsDetail }
        )
      );

      // === Pagination contract ===
      // The SEP is permissive: a single-page response with no nextCursor is
      // conformant. The check passes when either (a) the first response has
      // no nextCursor at all, or (b) the cursor round-trips on a follow-up
      // call. mcpkit's defaultDirectoryReadPageSize = 0 puts it in (a).
      let paginationOk = false;
      let paginationDetail = '';
      const firstCursor = happy?.nextCursor;
      if (!firstCursor) {
        paginationOk = true;
        paginationDetail = 'single-page response (no nextCursor)';
      } else {
        try {
          const second = await conn.request<DirectoryReadResult>(
            'resources/directory/read',
            { uri: HAPPY_PATH_URI, cursor: firstCursor }
          );
          paginationOk = Array.isArray(second.resources);
          paginationDetail = paginationOk
            ? `nextCursor round-tripped: ${firstCursor}`
            : 'follow-up call returned non-array resources';
        } catch (e) {
          paginationDetail = `follow-up call with cursor failed: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
      checks.push(
        check(
          'sep-2640-directory-read-pagination',
          'nextCursor round-trips per the resources/list contract (single-page responses are conformant).',
          paginationOk ? 'SUCCESS' : 'FAILURE',
          paginationOk
            ? { details: { paginationDetail } }
            : { errorMessage: paginationDetail }
        )
      );

      return checks;
    } finally {
      await conn.close();
    }
  }
}
