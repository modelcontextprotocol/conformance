# spec-types

Vendored copies of `schema/{version}/schema.ts` and
`schema/{version}/schema.json` from the
[modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
spec repository.

The `.ts` files are the canonical TypeScript types for each protocol version.
The conformance suite imports types from here rather than from
`@modelcontextprotocol/sdk` so that it can test draft spec versions before any
SDK has implemented them.

The `.schema.json` files are the matching JSON Schemas; `src/validation`
compiles them (per version) to validate every JSON-RPC message the harness
sends or receives at runtime.

**Do not edit these files by hand.** To refresh:

```sh
npm run sync-schema -- <sha-or-ref>
```

The `SOURCE` file records the spec commit the current copies came from.

`ext-tasks.schema.json` is `schema/draft/schema.json` from the
[ext-tasks](https://github.com/modelcontextprotocol/ext-tasks) repository
(SEP-2663); `src/validation` validates a `resultType: "task"` result
against its `CreateTaskResult` for versions whose core schema no longer
carries one. `SOURCE.ext-tasks` records its commit.

## Import rule

A scenario imports the schema matching its `source.introducedIn`:

```ts
import type { ListToolsResult } from '../../spec-types/2025-06-18';
```

`Connection` implementations import the version whose lifecycle they implement
(stateful → `2025-11-25`, stateless → `draft`).
