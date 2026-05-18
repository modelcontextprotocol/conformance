# SEP-2322 MRTR — Server Conformance

Tests any MCP server that implements the SEP-2322 ephemeral
Multi Round-Trip Request flow on `tools/call` — the
`InputRequiredResult` → retry-with-`inputResponses` → `ToolResult`
contract that lets a tool gather elicitation / sampling / roots input
without creating a task envelope. The variant was renamed from
`IncompleteResult` / `"incomplete"` in SEP-2322 commit `de6d76fb`
(merged 2026-05-06).

## Specs covered

| SEP      | What it adds                                                                                                     | Where it shows up             |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| SEP-2322 | Ephemeral MRTR — `resultType` discriminator, `inputRequests` / `inputResponses` keyed maps, `requestState` token | every check                   |
| SEP-2663 | MRTR → Tasks composition (final round returns `CreateTaskResult`)                                                | mrtr-08 (SKIPPED — see below) |

## ClientScenario classes

### `mrtr-ephemeral-flow` (`ephemeral-flow.ts`)

A single scenario covering the full ephemeral MRTR contract — per the
AGENTS.md "fewer scenarios, more checks" rule. A server that
implemented elicitation round-trips but not sampling round-trips would
be incoherent, so they bundle.

| Check                                    | What it tests                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mrtr-basic-elicitation-round-trip`      | Round 1 returns `InputRequiredResult` with `elicitation/create`; round 2 completes with the answer reflected                       |
| `mrtr-sampling-round-trip`               | Same flow with `sampling/createMessage`                                                                                            |
| `mrtr-roots-list-round-trip`             | Same flow with `roots/list`                                                                                                        |
| `mrtr-request-state-round-trip`          | When server emits `requestState`, it's a non-empty string and the server validates the echo                                        |
| `mrtr-multiple-input-requests-one-round` | A single `InputRequiredResult` MAY carry inputRequests for `elicitation/create` + `sampling/createMessage` + `roots/list` together |
| `mrtr-multi-round-flow`                  | A handler MAY take 2+ rounds; each round mints a fresh `requestState`; final result reflects answers from every round              |
| `mrtr-wrong-input-key-rerequests`        | When client sends a wrong `inputResponses` key, server SHOULD re-request via `InputRequiredResult` rather than erroring            |
| `mrtr-tasks-composition`                 | **SKIPPED** — see "Open issues" below                                                                                              |

## Required server fixtures

The fixture server MUST register these tools:

| Tool                                     | Behavior                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `test_tool_with_elicitation`             | One `elicitation/create` round, completes with answer reflected                             |
| `test_incomplete_result_sampling`        | One `sampling/createMessage` round                                                          |
| `test_incomplete_result_list_roots`      | One `roots/list` round                                                                      |
| `test_incomplete_result_request_state`   | Exercises `requestState` validation; final result includes `state-ok` to confirm validation |
| `test_incomplete_result_multiple_inputs` | Emits 3+ inputRequests of different methods in one round                                    |
| `test_incomplete_result_multi_round`     | Drives 2+ MRTR rounds, final result references every answer                                 |
| `test_incomplete_result_elicitation`     | Emits inputRequest for `user_name`; server re-requests on wrong-key responses               |

The fixture can be implemented in any language; one example reference
implementation lives at
[`panyam/mcpkit/examples/mrtr`](https://github.com/panyam/mcpkit/tree/main/examples/mrtr).

## Running

```bash
# Against an already-running server
MRTR_SERVER_URL=http://localhost:8080/mcp \
  npx vitest run src/scenarios/server/mrtr/all-scenarios.test.ts

# Auto-spawn a fixture in beforeAll
MRTR_SERVER_URL=http://localhost:18093/mcp \
MRTR_SERVER_CMD="/path/to/mrtr-server --port 18093" \
  npx vitest run src/scenarios/server/mrtr/all-scenarios.test.ts
```

## Open issues

### `mrtr-tasks-composition` deferred

SEP-2663 commit `451f5e1` (Apr 30) made the MRTR → Tasks composition
flow normative: a `tools/call` MAY exchange `InputRequiredResult` rounds
to gather input, then return `CreateTaskResult` to go async on a
subsequent round. Two blockers prevent enabling the check today:

1. **Spec watch — discriminator value.** SEP-2322 merged on 2026-05-06
   with `"input_required"` (commit `de6d76fb` renamed the variant from
   IncompleteResult / `"incomplete"` per dsp-ant request). SEP-2663's
   PR head (82fb2c4d as of 2026-05-07 PM) still reads `"incomplete"`
   on line 121 of the mdx — Caitie's 5/15 RC commitment (issue
   comment 4384052694) tracks the alignment. The constant lives in
   `MRTR_INPUT_REQUIRED_RESULT_TYPE` (helpers.ts) so it's a one-line
   flip if SEP-2663's eventual alignment surprises us.

2. **Reference-impl gap.** The natural server-side implementation
   pattern for tasks (mint task up-front, run handler in a goroutine /
   async task) means the handler's `InputRequiredResult` signal isn't
   visible to the middleware in time — by the time the handler returns
   `IsInputRequired`, the `CreateTaskResult` is already on the wire. SDKs
   in any language need an inverted middleware pattern that runs the
   first round synchronously and only spins up the task once the
   handler signals async-promotion.
   ([panyam/mcpkit issue 347](https://github.com/panyam/mcpkit/issues/347)
   tracks this for one example impl; SDKs in any language hit the
   same architectural choice.)

The check is registered with `status: 'SKIPPED'` so it's discoverable
but doesn't fail conformance runs. When both blockers resolve, remove
the SKIPPED short-circuit in `ephemeral-flow.ts` Check 8.

## Design notes

### Why the MRTR scenarios share helpers with `tasks/`

`MRTR_INPUT_REQUIRED_RESULT_TYPE`, the result-type predicates
(`isInputRequiredResult`, `isCompleteResult`), and the elicitation/sampling/
roots mocks live in `mrtr/helpers.ts`. The shared `AnyResult` Zod
passthrough schema and `waitForTerminal`/`waitForStatus` polling helpers
are imported from the sibling `../tasks/helpers` because both scenario
sets share the same wire-shape problem (SDK Zod schemas strip extension
fields). Pair `client.request(req, AnyResult)` with the SDK's
`StreamableHTTPClientTransport` and you preserve every SEP-2322 / SEP-2663
field. When the upstream SDK gains schemas for those shapes, the
passthrough disappears in favor of the typed schemas directly.
