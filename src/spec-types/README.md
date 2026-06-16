# spec-types

Vendored copies of `schema/{version}/schema.ts` from the
[modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
spec repository.

These are the canonical TypeScript types for each protocol version. The
conformance suite imports types from here rather than from
`@modelcontextprotocol/sdk` so that it can test draft spec versions before any
SDK has implemented them.

**Do not edit these files by hand.** To refresh:

```sh
npm run sync-schema -- <sha-or-ref>
```

The `SOURCE` file records the spec commit the current copies came from.

## Import rule

A scenario imports the schema matching its `source.introducedIn`:

```ts
import type { ListToolsResult } from '../../spec-types/2025-06-18';
```

`Connection` implementations import the version whose lifecycle they implement
(stateful → `2025-11-25`, stateless → `draft`).
