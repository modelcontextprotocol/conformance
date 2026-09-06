# spec-types

Vendored copies of `schema/{version}/schema.ts` and
`schema/{version}/schema.json` from the
[modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
spec repository.

The `.ts` files are the canonical TypeScript types for each protocol version
(`draft` tracks `schema/draft/`, the revision after the latest release).
The conformance suite imports types from here rather than from
`@modelcontextprotocol/sdk` so that it can test spec versions before any SDK
has implemented them.

The `.schema.json` files are the matching JSON Schemas; `src/validation`
compiles them (per version) to validate every JSON-RPC message the harness
sends or receives at runtime.

**Do not edit these files by hand.** To refresh:

```sh
npm run sync-schema -- <sha-or-ref>
```

The script vendors every entry of `DATED_SPEC_VERSIONS` (src/types.ts) plus
`draft`, regenerates `schemas.ts` (the version → JSON Schema map the wire
validator uses), and records the spec commit in `SOURCE`.
`DRAFT_PROTOCOL_VERSION` is read from the vendored `draft.ts`, so a draft
marker bump upstream is just a re-run of this script.

## Spec lifecycle checklist

**The spec repo bumps the draft's `LATEST_PROTOCOL_VERSION`** (e.g. to a
`DRAFT-YYYY-vN` marker): `npm run sync-schema -- <sha>`. Nothing else.

**A requirement lands in `docs/specification/draft/` and gets a scenario**:
tag it `source: { introducedIn: DRAFT_SPEC_VERSION }` (or
`removedIn: DRAFT_SPEC_VERSION` for something the draft removes). It runs under
`--spec-version draft` / `--suite draft` and stays out of the default suites
and tier scoring.

**A new revision `YYYY-MM-DD` is released**:

1. Append `'YYYY-MM-DD'` to `DATED_SPEC_VERSIONS` in `src/types.ts`
   (`LATEST_SPEC_VERSION` follows automatically). If the revision keeps the
   stateful initialize lifecycle, also add it to `STATEFUL_VERSIONS` in
   `src/connection/select.ts`; otherwise it is stateless by default.
2. `npm run sync-schema -- <release tag>` (vendors `schema/YYYY-MM-DD`,
   regenerates `schemas.ts`).
3. Retag the scenarios that shipped: `DRAFT_SPEC_VERSION` → `'YYYY-MM-DD'` in
   `introducedIn`/`removedIn` for every requirement the release includes
   (`rg DRAFT_SPEC_VERSION src/scenarios`). Anything still unreleased keeps
   the draft tag.
4. Freeze `requirements/YYYY-MM-DD.yaml` (start from
   `conformance list --spec-version YYYY-MM-DD`; see the header comments in
   the existing files for what goes in `not_scored`). A test insists the
   latest dated version has one.
5. Add `specOverrides['YYYY-MM-DD']` entries in `src/sdk-runner/known-sdks.ts`
   for SDKs that need a different invocation at the new wire, and skim
   README examples that name the latest revision.

Help text, the draft-suite/`--spec-version draft` notes, the stateless
version lists, the tier-check matrix columns and the wire validator all
derive from `DATED_SPEC_VERSIONS` and need no edits.

## Import rule

A scenario imports the schema matching its `source.introducedIn`:

```ts
import type { ListToolsResult } from '../../spec-types/2025-06-18';
```

`Connection` implementations import the version whose lifecycle they implement
(stateful → `2025-11-25`, stateless → `2026-07-28`).
