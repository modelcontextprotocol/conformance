# MCP SDK Canonical Feature List

Single source of truth for all MCP features evaluated in the tier audit. **48 non-experimental features** plus 5 experimental (informational only).

When updating this list, also update the total count referenced in `docs-coverage-prompt.md`.

## Non-Experimental Features (48 total)

### Core Features (36)

| #   | Feature                             | Protocol Method                        |
| --- | ----------------------------------- | -------------------------------------- |
| 1   | Tools - listing                     | `tools/list`                           |
| 2   | Tools - calling                     | `tools/call`                           |
| 3   | Tools - text results                |                                        |
| 4   | Tools - image results               |                                        |
| 5   | Tools - audio results               |                                        |
| 6   | Tools - embedded resources          |                                        |
| 7   | Tools - error handling              |                                        |
| 8   | Tools - change notifications        | `notifications/tools/list_changed`     |
| 9   | Resources - listing                 | `resources/list`                       |
| 10  | Resources - reading text            | `resources/read`                       |
| 11  | Resources - reading binary          | `resources/read`                       |
| 12  | Resources - templates               | `resources/templates/list`             |
| 13  | Resources - template reading        |                                        |
| 14  | Resources - subscribing             | `resources/subscribe`                  |
| 15  | Resources - unsubscribing           | `resources/unsubscribe`                |
| 16  | Resources - change notifications    | `notifications/resources/list_changed` |
| 17  | Prompts - listing                   | `prompts/list`                         |
| 18  | Prompts - getting simple            | `prompts/get`                          |
| 19  | Prompts - getting with arguments    | `prompts/get`                          |
| 20  | Prompts - embedded resources        |                                        |
| 21  | Prompts - image content             |                                        |
| 22  | Prompts - change notifications      | `notifications/prompts/list_changed`   |
| 23  | Sampling - creating messages        | `sampling/createMessage`               |
| 24  | Elicitation - form mode             | `elicitation/create`                   |
| 25  | Elicitation - URL mode              | `elicitation/create` (mode: "url")     |
| 26  | Elicitation - schema validation     |                                        |
| 27  | Elicitation - default values        |                                        |
| 28  | Elicitation - enum values           |                                        |
| 29  | Elicitation - complete notification | `notifications/elicitation/complete`   |
| 30  | Roots - listing                     | `roots/list`                           |
| 31  | Roots - change notifications        | `notifications/roots/list_changed`     |
| 32  | Logging - sending log messages      | `notifications/message`                |
| 33  | Logging - setting level             | `logging/setLevel`                     |
| 34  | Completions - resource argument     | `completion/complete`                  |
| 35  | Completions - prompt argument       | `completion/complete`                  |
| 36  | Ping                                | `ping`                                 |

### Transport Features (6)

| #   | Feature                            |
| --- | ---------------------------------- |
| 37  | Streamable HTTP transport (client) |
| 38  | Streamable HTTP transport (server) |
| 39  | SSE transport - legacy (client)    |
| 40  | SSE transport - legacy (server)    |
| 41  | stdio transport (client)           |
| 42  | stdio transport (server)           |

### Protocol Features (6)

| #   | Feature                      |
| --- | ---------------------------- |
| 43  | Progress notifications       |
| 44  | Cancellation                 |
| 45  | Pagination                   |
| 46  | Capability negotiation       |
| 47  | Protocol version negotiation |
| 48  | JSON Schema 2020-12 support  |

## Experimental Features (5, informational only)

| #   | Feature                      | Protocol Method              |
| --- | ---------------------------- | ---------------------------- |
| —   | Tasks - get                  | `tasks/get`                  |
| —   | Tasks - result               | `tasks/result`               |
| —   | Tasks - cancel               | `tasks/cancel`               |
| —   | Tasks - list                 | `tasks/list`                 |
| —   | Tasks - status notifications | `notifications/tasks/status` |
