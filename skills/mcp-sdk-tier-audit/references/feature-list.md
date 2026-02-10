# Canonical MCP Feature List

This is the canonical list of MCP features used for SDK coverage evaluation. Features are organized by category and tagged with whether they are required for tier assessment.

Source: MCP specification schema and conformance test scenarios.

## Core Features (required for tier documentation assessment)

These features are part of the core MCP protocol. Documentation coverage for these is required for Tier 2 (basic docs) and Tier 1 (comprehensive with examples).

### Tools
| Feature | Spec Method | Description |
|---|---|---|
| Tools - listing | `tools/list` | List available tools from the server |
| Tools - calling | `tools/call` | Invoke a tool on the server |
| Tools - text results | `tools/call` response | Handle text content in tool results |
| Tools - image results | `tools/call` response | Handle image content in tool results |
| Tools - audio results | `tools/call` response | Handle audio content in tool results |
| Tools - embedded resources | `tools/call` response | Handle embedded resource content in tool results |
| Tools - error handling | `tools/call` response | Handle isError flag in tool results |
| Tools - change notifications | `notifications/tools/list_changed` | React to tool list changes |

### Resources
| Feature | Spec Method | Description |
|---|---|---|
| Resources - listing | `resources/list` | List available resources |
| Resources - reading text | `resources/read` | Read text resource content |
| Resources - reading binary | `resources/read` | Read binary/blob resource content |
| Resources - templates | `resources/templates/list` | List and use URI templates |
| Resources - template reading | `resources/read` (with template URI) | Read resources via URI templates |
| Resources - subscribing | `resources/subscribe` | Subscribe to resource change notifications |
| Resources - unsubscribing | `resources/unsubscribe` | Unsubscribe from resource notifications |
| Resources - change notifications | `notifications/resources/list_changed` | React to resource list changes |

### Prompts
| Feature | Spec Method | Description |
|---|---|---|
| Prompts - listing | `prompts/list` | List available prompts |
| Prompts - getting (simple) | `prompts/get` | Get a prompt with no arguments |
| Prompts - getting (with args) | `prompts/get` | Get a prompt with arguments |
| Prompts - embedded resources | `prompts/get` response | Handle embedded resources in prompt messages |
| Prompts - image content | `prompts/get` response | Handle image content in prompt messages |
| Prompts - change notifications | `notifications/prompts/list_changed` | React to prompt list changes |

### Sampling
| Feature | Spec Method | Description |
|---|---|---|
| Sampling - creating messages | `sampling/createMessage` | Server requests LLM sampling from client |

### Elicitation
| Feature | Spec Method | Description |
|---|---|---|
| Elicitation - requesting input | `elicitation/create` | Server requests structured user input from client |
| Elicitation - schema validation | `elicitation/create` | Validate elicitation responses against JSON schema |
| Elicitation - default values | `elicitation/create` | Support default values in elicitation schemas |
| Elicitation - enum values | `elicitation/create` | Support enum constraints in elicitation schemas |

### Roots
| Feature | Spec Method | Description |
|---|---|---|
| Roots - listing | `roots/list` | Server requests list of client roots |
| Roots - change notifications | `notifications/roots/list_changed` | Client notifies server of root changes |

### Logging
| Feature | Spec Method | Description |
|---|---|---|
| Logging - sending log messages | `notifications/message` | Server sends log messages to client |
| Logging - setting level | `logging/setLevel` | Client sets minimum log level |

### Completions
| Feature | Spec Method | Description |
|---|---|---|
| Completions - resource argument | `completion/complete` | Auto-complete resource URI arguments |
| Completions - prompt argument | `completion/complete` | Auto-complete prompt arguments |

### Ping
| Feature | Spec Method | Description |
|---|---|---|
| Ping | `ping` | Keepalive / connectivity check |

## Transport Features

### Streamable HTTP Transport
| Feature | Description |
|---|---|
| Streamable HTTP - client | Client-side streamable HTTP transport implementation |
| Streamable HTTP - server | Server-side streamable HTTP transport implementation |
| Streamable HTTP - SSE streaming | Server-sent events for streaming responses |
| Streamable HTTP - session management | Session ID tracking and management |

### SSE Transport (Legacy)
| Feature | Description |
|---|---|
| SSE transport - client | Legacy SSE transport client (backward compatibility) |
| SSE transport - server | Legacy SSE transport server (backward compatibility) |

### stdio Transport
| Feature | Description |
|---|---|
| stdio transport - client | stdio-based transport client |
| stdio transport - server | stdio-based transport server |

## Protocol Features

| Feature | Spec Method | Description |
|---|---|---|
| Progress notifications | `notifications/progress` | Report progress during long-running operations |
| Cancellation | `notifications/cancelled` | Cancel in-progress requests |
| Pagination | `cursor` parameter | Paginated listing of tools, resources, prompts |
| Capability negotiation | `initialize` / `initialized` | Client-server capability handshake |
| Protocol version negotiation | `initialize` | Negotiate supported protocol version |
| DNS rebinding protection | N/A (transport-level) | Validate Origin/Host headers to prevent DNS rebinding |

## Experimental Features (NOT required for any tier)

| Feature | Description |
|---|---|
| Tasks | Task tracking and management (experimental) |

## Conformance Test Scenario Mapping

The following maps conformance test scenarios to the features above:

| Conformance Scenario | Feature(s) Tested |
|---|---|
| `lifecycle` | Capability negotiation, Protocol version negotiation |
| `tools-list` | Tools - listing |
| `tools-call-simple-text` | Tools - calling, Tools - text results |
| `tools-call-image` | Tools - image results |
| `tools-call-audio` | Tools - audio results |
| `tools-call-embedded-resource` | Tools - embedded resources |
| `tools-call-multiple-content-types` | Tools - text/image/audio results |
| `tools-call-with-logging` | Tools - calling, Logging - sending log messages |
| `tools-call-error` | Tools - error handling |
| `tools-call-with-progress` | Progress notifications |
| `tools-call-sampling` | Sampling - creating messages |
| `tools-call-elicitation` | Elicitation - requesting input |
| `elicitation-defaults` | Elicitation - default values |
| `elicitation-enums` | Elicitation - enum values |
| `resources-list` | Resources - listing |
| `resources-read-text` | Resources - reading text |
| `resources-read-binary` | Resources - reading binary |
| `resources-template-read` | Resources - templates, Resources - template reading |
| `resources-subscribe` | Resources - subscribing |
| `resources-unsubscribe` | Resources - unsubscribing |
| `prompts-list` | Prompts - listing |
| `prompts-get-simple` | Prompts - getting (simple) |
| `prompts-get-with-args` | Prompts - getting (with args) |
| `prompts-get-embedded-resource` | Prompts - embedded resources |
| `prompts-get-with-image` | Prompts - image content |
| `ping` | Ping |
| `logging-set-level` | Logging - setting level |
| `completion-complete` | Completions - resource/prompt argument |
| `dns-rebinding-protection` | DNS rebinding protection |
| `sse-polling` | Streamable HTTP - SSE streaming |
| `sse-multiple-streams` | Streamable HTTP - SSE streaming, session management |
