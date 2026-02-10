# Feature Coverage Subagent Prompt

You are evaluating the feature/spec coverage of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **Repository**: {repo} (e.g., `modelcontextprotocol/typescript-sdk`)
- **Branch**: {branch} (default branch if not specified)

## Your Task

Evaluate the SDK's implementation completeness against the MCP specification. Determine which spec features are implemented, partially implemented, or missing.

## Steps

### 1. Clone or access the repository

```bash
# If the repo is available locally at ~/src/mcp/{sdk-name}, read from there
# Otherwise clone it:
gh repo clone {repo} /tmp/sdk-audit-features -- --branch {branch} --depth 1
```

### 2. Identify the SDK's architecture

Determine the SDK's structure:
- Where are client implementations? (e.g., `src/client/`, `client.ts`, `mcp/client/`)
- Where are server implementations? (e.g., `src/server/`, `server.ts`, `mcp/server/`)
- Where are transport implementations? (e.g., `src/transport/`, `transports/`)
- Where are type definitions? (e.g., `src/types/`, `types.ts`, `schema/`)
- What protocol version does the SDK target?

```bash
# Identify key source files
find /path/to/repo/src -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.cs" -o -name "*.java" -o -name "*.kt" -o -name "*.swift" -o -name "*.rs" -o -name "*.rb" -o -name "*.php" | head -50

# Look for protocol version references
grep -rn "protocolVersion\|protocol_version\|PROTOCOL_VERSION\|LATEST_PROTOCOL_VERSION" /path/to/repo/src/
```

### 3. Check each spec feature

For each feature in the canonical list, search the source code to determine if it is implemented.

**How to verify implementation:**
- Look for method/function definitions that handle the spec method (e.g., `tools/list`, `resources/read`)
- Check for request/response type definitions
- Verify handler registration or routing for each method
- Check both client-side and server-side implementations

```bash
# Example searches for TypeScript SDK
grep -rn "tools/list\|toolsList\|tools_list\|listTools\|list_tools" /path/to/repo/src/
grep -rn "resources/read\|resourcesRead\|resources_read\|readResource\|read_resource" /path/to/repo/src/
grep -rn "sampling/createMessage\|samplingCreateMessage\|createMessage\|create_message" /path/to/repo/src/
grep -rn "elicitation/create\|elicitationCreate\|createElicitation\|create_elicitation" /path/to/repo/src/
```

### 4. Check protocol version tracking

Determine:
- Which MCP spec version(s) does the SDK support?
- Is there a version constant or configuration?
- Does the SDK handle version negotiation during initialization?

```bash
grep -rn "2025-06-18\|2024-11-05\|draft" /path/to/repo/src/ --include="*.ts" --include="*.py" --include="*.go" --include="*.cs" --include="*.java"
```

### 5. Cross-reference with MCP spec schema

The MCP specification defines these methods. Check each one:

**Lifecycle:**
- `initialize` / `initialized`
- `ping`

**Tools:**
- `tools/list`
- `tools/call`
- `notifications/tools/list_changed`

**Resources:**
- `resources/list`
- `resources/read`
- `resources/templates/list`
- `resources/subscribe`
- `resources/unsubscribe`
- `notifications/resources/list_changed`
- `notifications/resources/updated`

**Prompts:**
- `prompts/list`
- `prompts/get`
- `notifications/prompts/list_changed`

**Sampling:**
- `sampling/createMessage`

**Elicitation:**
- `elicitation/create`

**Roots:**
- `roots/list`
- `notifications/roots/list_changed`

**Logging:**
- `logging/setLevel`
- `notifications/message` (log messages)

**Completions:**
- `completion/complete`

**Progress:**
- `notifications/progress`

**Cancellation:**
- `notifications/cancelled`

**Transports:**
- Streamable HTTP (client and server)
- SSE (legacy, client and server)
- stdio (client and server)

## Canonical Feature List

### Core Protocol Methods

| Spec Method | Category | Required Side(s) | Description |
|---|---|---|---|
| `initialize` | Lifecycle | Client + Server | Capability negotiation handshake |
| `initialized` | Lifecycle | Client + Server | Post-handshake notification |
| `ping` | Utility | Client + Server | Keepalive check |
| `tools/list` | Tools | Server (handler) + Client (caller) | List available tools |
| `tools/call` | Tools | Server (handler) + Client (caller) | Invoke a tool |
| `notifications/tools/list_changed` | Tools | Server (sender) + Client (receiver) | Tool list change notification |
| `resources/list` | Resources | Server (handler) + Client (caller) | List resources |
| `resources/read` | Resources | Server (handler) + Client (caller) | Read a resource |
| `resources/templates/list` | Resources | Server (handler) + Client (caller) | List URI templates |
| `resources/subscribe` | Resources | Server (handler) + Client (caller) | Subscribe to resource updates |
| `resources/unsubscribe` | Resources | Server (handler) + Client (caller) | Unsubscribe from updates |
| `notifications/resources/list_changed` | Resources | Server (sender) + Client (receiver) | Resource list change notification |
| `notifications/resources/updated` | Resources | Server (sender) + Client (receiver) | Resource content update notification |
| `prompts/list` | Prompts | Server (handler) + Client (caller) | List prompts |
| `prompts/get` | Prompts | Server (handler) + Client (caller) | Get a prompt |
| `notifications/prompts/list_changed` | Prompts | Server (sender) + Client (receiver) | Prompt list change notification |
| `sampling/createMessage` | Sampling | Client (handler) + Server (caller) | Request LLM sampling |
| `elicitation/create` | Elicitation | Client (handler) + Server (caller) | Request user input |
| `roots/list` | Roots | Client (handler) + Server (caller) | List client roots |
| `notifications/roots/list_changed` | Roots | Client (sender) + Server (receiver) | Root list change notification |
| `logging/setLevel` | Logging | Server (handler) + Client (caller) | Set log level |
| `notifications/message` | Logging | Server (sender) + Client (receiver) | Log message |
| `completion/complete` | Completions | Server (handler) + Client (caller) | Auto-complete arguments |
| `notifications/progress` | Progress | Both (sender + receiver) | Progress reporting |
| `notifications/cancelled` | Cancellation | Both (sender + receiver) | Request cancellation |

### Transport Implementations

| Transport | Client Implementation | Server Implementation |
|---|---|---|
| Streamable HTTP | HTTP client with SSE support | HTTP server with SSE streaming |
| SSE (legacy) | EventSource-based client | SSE endpoint server |
| stdio | Process stdin/stdout client | Process stdin/stdout server |

## Required Output Format

Produce your assessment in this exact format:

```markdown
### Feature Coverage Assessment

**Repository**: {repo}
**Branch**: {branch}
**Protocol version(s) supported**: {version(s) found in source}
**SDK architecture**: {brief description of client/server/transport structure}

#### Spec Method Implementation Table

| Spec Method | Category | Client Support | Server Support | Evidence | Notes |
|---|---|---|---|---|---|
| `initialize` | Lifecycle | Implemented | Implemented | {file}:{line} | {notes} |
| `initialized` | Lifecycle | Implemented | Implemented | {file}:{line} | {notes} |
| `ping` | Utility | Implemented | Implemented | {file}:{line} | {notes} |
| `tools/list` | Tools | Implemented | Implemented | {file}:{line} | {notes} |
| `tools/call` | Tools | Implemented | Implemented | {file}:{line} | {notes} |
| `notifications/tools/list_changed` | Tools | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `resources/list` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `resources/read` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `resources/templates/list` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `resources/subscribe` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `resources/unsubscribe` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/resources/list_changed` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/resources/updated` | Resources | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `prompts/list` | Prompts | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `prompts/get` | Prompts | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/prompts/list_changed` | Prompts | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `sampling/createMessage` | Sampling | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `elicitation/create` | Elicitation | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `roots/list` | Roots | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/roots/list_changed` | Roots | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `logging/setLevel` | Logging | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/message` | Logging | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `completion/complete` | Completions | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/progress` | Progress | {status} | {status} | {file}:{line} or "Not found" | {notes} |
| `notifications/cancelled` | Cancellation | {status} | {status} | {file}:{line} or "Not found" | {notes} |

Status values: `Implemented`, `Partial`, `Not implemented`, `N/A`

#### Transport Implementation Table

| Transport | Client | Server | Evidence | Notes |
|---|---|---|---|---|
| Streamable HTTP | {status} | {status} | {file}:{line} | {notes} |
| SSE (legacy) | {status} | {status} | {file}:{line} | {notes} |
| stdio | {status} | {status} | {file}:{line} | {notes} |

#### Content Type Support

| Content Type | Supported? | Evidence | Notes |
|---|---|---|---|
| Text content | {Yes/No} | {file}:{line} | {notes} |
| Image content | {Yes/No} | {file}:{line} | {notes} |
| Audio content | {Yes/No} | {file}:{line} | {notes} |
| Embedded resources | {Yes/No} | {file}:{line} | {notes} |

#### Summary

**Total spec methods**: 25
**Fully implemented (both sides)**: {N}
**Partially implemented**: {N}
**Not implemented**: {N}

**Implementation coverage**: {N}/25 ({percentage}%)

**Missing features**:
- {feature 1}: {brief explanation of what is missing}
- {feature 2}: {brief explanation}
- ...

**Protocol version**: {version} -- {Is this the latest spec version? If not, what is missing?}
```

## Important Notes

- "Implemented" means both the type definitions AND the handler/caller logic exist. Having only types is "Partial".
- Check BOTH client and server sides. An SDK may implement the server handler for `tools/list` but not the client caller, or vice versa.
- For notifications, check that both sending and receiving are implemented.
- For transports, check that there is actual transport implementation code, not just type stubs.
- Include file:line references for every piece of evidence so reviewers can verify findings.
- If the SDK uses a different naming convention (e.g., snake_case vs camelCase), search for both patterns.
- Experimental features (like Tasks) should be noted if present but do NOT count toward tier requirements.
