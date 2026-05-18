# SEP-2663 Tasks Extension — Server Conformance

Tests any MCP server that implements the `io.modelcontextprotocol/tasks`
extension (SEP-2663) plus the SEP-2322 base types it builds on, the
SEP-2575 per-request capability override, and the SEP-2243 routing
headers.

The scenarios assert what the spec text says — not what any particular
implementation does. When the SDK schemas in
`@modelcontextprotocol/sdk/types.js` lag the spec, scenarios bypass
the SDK and use raw `fetch` so the SEP-2663 wire fields (`resultType`,
`taskId`, `inputRequests`, `requestState`, inlined `result`/`error`)
aren't stripped.

## Specs covered

| SEP      | What it adds                                                                                                                                                                                                                                                                                                                                                                                | Where it shows up                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| SEP-2663 | Tasks Extension — `io.modelcontextprotocol/tasks` capability, flat `CreateTaskResult` (`Result & Task`), `DetailedTask` on `tasks/get` (with inlined result/error/inputRequests/requestState), `tasks/update` for MRTR resume, ack-only `tasks/cancel`, wire-field renames (`ttlMs`, `pollIntervalMs`, both integer milliseconds per the 2026-05-07 spec commit aligning duration suffixes) | every scenario                      |
| SEP-2322 | MRTR base types — `inputRequests`/`inputResponses` keyed maps, `requestState`, `resultType` discriminator (`"task"`/`"complete"`/`"incomplete"`)                                                                                                                                                                                                                                            | request-state, mrtr-input, dispatch |
| SEP-2575 | Per-request capability override via `_meta.io.modelcontextprotocol/clientCapabilities`                                                                                                                                                                                                                                                                                                      | capability                          |
| SEP-2243 | Server tolerates `Mcp-Method` / `Mcp-Name` request headers as informational routing metadata; body is authoritative                                                                                                                                                                                                                                                                         | headers                             |

## ClientScenario classes

Per the AGENTS.md "fewer scenarios, more checks" rule, related checks
are bundled into one scenario class with multiple `ConformanceCheck`
records. Each row below is one class.

### `tasks-lifecycle` (`lifecycle.ts`)

Sync vs async dispatch, DetailedTask shape on tasks/get, tool errors
vs protocol errors, cancellation semantics.

| Check                                | What it tests                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tasks-sync-tool-call`               | Sync tool returns `resultType:"complete"`; no top-level `taskId`                                                                                 |
| `tasks-server-task-creation`         | Task-supporting tool returns flat `CreateTaskResult` (no nested `task` wrapper); MUST NOT carry `result`/`error`/`inputRequests` on the envelope |
| `tasks-get-during-working`           | `tasks/get` on an active task returns status + metadata                                                                                          |
| `tasks-get-terminal-inlined-result`  | Completed task `tasks/get` inlines `result.content[]` (no separate `tasks/result`)                                                               |
| `tasks-tool-error-completed-iserror` | Tool execution errors → `status:"completed"` + `result.isError:true` (NOT `failed`)                                                              |
| `tasks-protocol-error-failed-shape`  | Protocol errors → `status:"failed"` with inlined `error{code,message}`; no `result`                                                              |
| `tasks-cancel-empty-ack`             | `tasks/cancel` returns `{resultType:"complete"}`; status settles to cancelled                                                                    |
| `tasks-cancel-terminal-rejected`     | `tasks/cancel` on a terminal task returns `-32602` (clarified in spec commit `d963ad0`)                                                          |

### `tasks-capability-negotiation` (`capability.ts`)

| Check                                     | What it tests                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tasks-extension-advertised`              | Server advertises `io.modelcontextprotocol/tasks` under `capabilities.extensions`; v1 `capabilities.tasks` slot stays absent               |
| `tasks-methods-gated-without-extension`   | `tasks/get`, `tasks/update`, `tasks/cancel` return `-32601` for sessions that didn't negotiate the extension                               |
| `tasks-tools-call-without-extension-sync` | `tools/call` from a non-negotiated session falls through to sync (no `CreateTaskResult`)                                                   |
| `tasks-per-request-meta-opt-in`           | SEP-2575 — per-request `_meta.io.modelcontextprotocol/clientCapabilities` produces `CreateTaskResult` even without session-level extension |

### `tasks-wire-fields` (`wire-fields.ts`)

| Check                                          | What it tests                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tasks-wire-field-renames`                     | `ttlMs` + `pollIntervalMs` present and integer-valued; legacy `ttl` / `pollInterval` keys absent |
| `tasks-no-early-ttl-expiry`                    | Task remains accessible via `tasks/get` for the duration of its `ttlMs`                          |
| `tasks-no-related-task-meta-on-inlined-result` | v1 `io.modelcontextprotocol/related-task` `_meta` key absent on tasks/get's inlined `result`     |

### `tasks-request-state` (`request-state.ts`)

| Check                                 | What it tests                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tasks-request-state-shape`           | When emitted, `requestState` is a non-empty string (`INFO` if server omits it; emission is optional per SEP-2322) |
| `tasks-request-state-echo`            | Server accepts `tasks/get` with the previously-emitted `requestState` echoed back                                 |
| `tasks-request-state-stale-tolerance` | Earlier (stale-but-still-valid) `requestState` MUST still be accepted after a newer one is minted                 |

### `tasks-mrtr-input` (`mrtr-input.ts`)

| Check                                    | What it tests                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tasks-mrtr-input-requests-on-tasks-get` | `tasks/get` on `input_required` task surfaces non-empty `inputRequests` map                                     |
| `tasks-mrtr-tasks-update-resumes`        | `tasks/update` with matching `inputResponses` is acked with `{resultType:"complete"}`; task resumes to terminal |
| `tasks-mrtr-partial-fulfillment`         | A subset-of-keys `tasks/update` keeps the task in `input_required` with only the unanswered key remaining       |

### `tasks-request-headers` (`headers.ts`)

| Check                                                 | What it tests                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tasks-headers-tolerate-mcp-method-on-tools-call`     | Server tolerates `Mcp-Method` request header on `tools/call` (sync dispatch unaffected)          |
| `tasks-headers-tolerate-routing-headers-on-tasks-get` | Server tolerates `Mcp-Method` + `Mcp-Name` request headers on `tasks/get` (body taskId resolves) |
| `tasks-headers-body-method-authoritative`             | When `Mcp-Method` header disagrees with body, server MUST dispatch on body method                |

> SEP-2243 defines these as **request** headers (client → server) used by HTTP infrastructure for routing. Whether the server _also_ echoes them on responses for downstream observability is implementation-defined and out of scope here.

### `tasks-dispatch-and-envelope` (`dispatch.ts`)

| Check                                              | What it tests                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tasks-removed-tasks-result`                       | `tasks/result` removed in v2 → `-32601`                                                                  |
| `tasks-removed-tasks-list`                         | `tasks/list` removed in v2 → `-32601`                                                                    |
| `tasks-server-directed-creation-no-hint`           | `tools/call` without client `task` hint still produces `CreateTaskResult`                                |
| `tasks-legacy-task-param-ignored`                  | Legacy v1 `task` param tolerated AND ignored on a sync tool (no error, no promotion)                     |
| `tasks-immediate-result-shortcut`                  | Fast operation MAY skip task creation and return a sync `ToolResult`                                     |
| `tasks-result-type-complete-on-non-task-responses` | Sync `tools/call`, `tasks/get`, `tasks/update` ack, `tasks/cancel` ack all carry `resultType:"complete"` |
| `tasks-strong-consistency-immediate-get`           | `tasks/get` immediately after `CreateTaskResult` MUST resolve (no -32602)                                |
| `tasks-get-unknown-task-id-rejected`               | `tasks/get` with unknown taskId returns `-32602`                                                         |

### `tasks-status-notifications` (`notifications.ts`)

| Check                              | What it tests                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks-status-notifications-shape` | Optional check — when sent, each `notifications/tasks/status` carries `taskId` + `status`; terminal notifications SHOULD inline `result` (DetailedTask) |

> Notifications are optional per SEP-2663. The check emits `INFO` (not `FAILURE`) when no notifications are received, so a server that doesn't implement the optional path stays conformant.

## Required server fixtures

The fixture server MUST register these tools:

| Tool                 | Behavior                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| `greet`              | Sync — returns `Hello, {name}!`                                                         |
| `slow_compute`       | Async — `seconds`-second sleep, returns result; `seconds:0` for immediate path          |
| `failing_job`        | Async — always returns tool error after ~1s                                             |
| `protocol_error_job` | Async — panics, surfaces as protocol error                                              |
| `confirm_delete`     | Async — calls `TaskElicit` (single inputRequest)                                        |
| `multi_input`        | Async — fans out two `TaskElicit` calls in parallel (used by partial-fulfillment check) |

The fixture can be implemented in any language; one example reference
implementation lives at
[`panyam/mcpkit/examples/tasks-v2`](https://github.com/panyam/mcpkit/tree/main/examples/tasks-v2).

## Running

The runner is brand-neutral and language-agnostic — it just shells out
to a command line and waits for the URL to become reachable.

### Against an already-running server

```bash
TASKS_SERVER_URL=http://localhost:8080/mcp \
  npx vitest run src/scenarios/server/tasks/all-scenarios.test.ts
```

### Auto-spawn a fixture in `beforeAll`

```bash
TASKS_SERVER_URL=http://localhost:18092/mcp \
TASKS_SERVER_CMD="/path/to/tasks-server --port 18092" \
  npx vitest run src/scenarios/server/tasks/all-scenarios.test.ts
```

If `TASKS_SERVER_URL` is unset, the suite is `describe.skip`'d so CI
runs against the upstream `everything-server` stay green until that
fixture grows SEP-2663 support.

## Open spec questions

Where the spec is silent or ambiguous, this suite picks the louder /
safer option (typically `-32602` over silent ack) so a misbehaving
server fails loudly rather than appearing well-formed. Today:

1. **Invalid `requestState`** — silent ack vs `-32602`. Suite asserts `-32602` (a server that silently accepts a forged token is a security hazard).
2. **SEP-2575 per-request capabilities envelope shape** — covered by `tasks-per-request-meta-opt-in`; the suite asserts only the observable behavior (`CreateTaskResult` produced) so the inner shape can evolve without churn.
3. **`tasks/update` / `tasks/cancel` for unknown taskId** — silent ack vs `-32602`. The read paths (`tasks/get` and `tasks/cancel` on terminal task) assert `-32602`; the write paths' upstream wording is too soft to assert against here.

## Wire-format diff vs MCP Tasks v1 (spec 2025-11-25)

| Aspect                     | v1                             | SEP-2663                                                                                       |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Capability slot            | `capabilities.tasks`           | `capabilities.extensions["io.modelcontextprotocol/tasks"]`                                     |
| Client opt-in              | (none)                         | MUST declare extension at session OR per-request (SEP-2575)                                    |
| Task creation              | Client sends `task` hint param | Server decides unilaterally                                                                    |
| `resultType` discriminator | absent                         | `"task"` (CreateTaskResult) / `"complete"` (everything else) / `"incomplete"` (MRTR ephemeral) |
| `CreateTaskResult` shape   | `{task: {...}}` (nested)       | flat: `{resultType, taskId, status, ttlMs, ...}` (no nested wrapper)                           |
| `tasks/get` response       | flat `TaskInfo` only           | `DetailedTask` with inlined `result`/`error`/`inputRequests`/`requestState`                    |
| `tasks/update`             | n/a                            | new — MRTR resume path, returns `{resultType:"complete"}` ack                                  |
| `tasks/cancel` response    | rich task envelope             | `{resultType:"complete"}` ack (no task state)                                                  |
| `tasks/result`             | separate blocking method       | **removed** (result inlined on `tasks/get`)                                                    |
| `tasks/list`               | session-scoped list            | **removed**                                                                                    |
| TTL field                  | `ttl` (ms by convention)       | `ttlMs` (integer milliseconds, units in name)                                                  |
| Poll-interval field        | `pollInterval`                 | `pollIntervalMs` (integer milliseconds)                                                        |
| `parentTaskId`             | present                        | removed                                                                                        |
| Tool errors                | `status:failed`                | `status:completed, result.isError:true`                                                        |
| Mcp-Name HTTP header       | not set                        | request-side routing header (SEP-2243)                                                         |

## Design notes

### Raw fetch escape hatch

The MCP TS SDK ships with strict Zod schemas that strip SEP-2663 /
SEP-2322 wire fields from responses (`resultType`, `taskId`,
`inputRequests`, `requestState`, inlined result/error). Scenarios that
exercise those fields use the raw-fetch helpers in `helpers.ts` rather
than the SDK client. When the SDK gains schemas for the SEP-2663
shapes, those call sites switch back to
`client.request(..., AnyResult)` and the helpers shrink (or disappear).

### Severity follows the spec keyword

Per AGENTS.md: MUST / MUST NOT → `FAILURE`; SHOULD / SHOULD NOT →
`WARNING`; optional emission with no presence → `INFO`. CI treats
`WARNING` as a failure, so SHOULD-level requirements still gate.
