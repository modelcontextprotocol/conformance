# MCP Server Conformance Requirements

This document specifies the requirements for building an MCP "Everything Server" for conformance testing. SDK maintainers should implement a server meeting these requirements to enable automated conformance testing.

## Purpose

The Everything Server is a reference implementation that:

- Demonstrates all MCP server features in a single, testable server
- Uses standardized naming conventions for tools, resources, and prompts
- Enables automated conformance testing across different SDK implementations
- Serves as a working example for SDK users

## Protocol Version

<!-- TODO: need to change to the new version before the official release, probaby worth havign separate tests for new and old version? -->

**Target MCP Specification**: `2025-06-18`

## Transport

**Required Transport**: Streamable HTTP (for initial conformance testing)

## Specification Compliance

This document specifies requirements based on the MCP specification. All features and behaviors described are mandated by the MCP specification itself and enable automated conformance testing.

---

## Server Information

### Server Identity

Your server MUST provide (can substitute your SDK name as the server name):

```json
{
  "name": "mcp-conformance-test-server",
  "version": "1.0.0"
}
```

### Capabilities Declaration

Your server MUST declare these capabilities during initialization:

```json
{
  "capabilities": {
    "tools": {
      "listChanged": true
    },
    "resources": {
      "subscribe": true,
      "listChanged": true
    },
    "prompts": {
      "listChanged": true
    },
    "logging": {},
    "completions": {}
  }
}
```

**Note**: All capabilities listed are required for conformance testing. The MCP specification also supports optional `experimental` capabilities for non-standard features, but these are not required for conformance.

---

## 1. Lifecycle Requirements

### 1.1. Initialize Handshake

**Endpoint**: `initialize`

**Requirements**:

- Accept `initialize` request with client info and capabilities
- Return server info, protocol version, and capabilities
- Protocol version MUST be `"2025-06-18"`

**Example Response**:

```json
{
  "protocolVersion": "2025-06-18",
  "serverInfo": {
    "name": "mcp-conformance-test-server",
    "version": "1.0.0"
  },
  "capabilities": {
    /* as above */
  }
}
```

### 1.2. Initialized Notification

**Notification**: `initialized`

**Requirements**:

- Accept `initialized` notification from client after handshake
- No response required (it's a notification)
- Server should be ready for requests after receiving this

---

## 2. Tools Requirements

### 2.1. List Tools

**Endpoint**: `tools/list`

**Requirements**:

- Return array of all available tools
- Each tool MUST have:
  - `name` (string)
  - `description` (string)
  - `inputSchema` (valid JSON Schema object)

### 2.2. Call Tool

**Endpoint**: `tools/call`

**Requirements**:

- Accept tool name and arguments
- Execute tool and return result
- Result MUST have `content` array
- Support `_meta.progressToken` for progress reporting (if provided)

### 2.3. Required Tools

Implement these tools with exact names:

#### `test_simple_text`

**Arguments**: None

**Returns**: Text content

```json
{
  "content": [
    {
      "type": "text",
      "text": "This is a simple text response for testing."
    }
  ]
}
```

#### `test_image_content`

**Arguments**: None

**Returns**: Image content with base64 data

```json
{
  "content": [
    {
      "type": "image",
      "data": "<base64-encoded-png>",
      "mimeType": "image/png"
    }
  ]
}
```

**Implementation Note**: Use a minimal test image (e.g., 1x1 red pixel PNG)

#### `test_audio_content`

**Arguments**: None

**Returns**: Audio content with base64 data

```json
{
  "content": [
    {
      "type": "audio",
      "data": "<base64-encoded-wav>",
      "mimeType": "audio/wav"
    }
  ]
}
```

**Implementation Note**: Use a minimal test audio file

#### `test_embedded_resource`

**Arguments**: None

**Returns**: Embedded resource content

```json
{
  "content": [
    {
      "type": "resource",
      "resource": {
        "uri": "test://embedded-resource",
        "mimeType": "text/plain",
        "text": "This is an embedded resource content."
      }
    }
  ]
}
```

#### `test_multiple_content_types`

**Arguments**: None

**Returns**: Multiple content items (text + image + resource)

```json
{
  "content": [
    {
      "type": "text",
      "text": "Multiple content types test:"
    },
    {
      "type": "image",
      "data": "<base64>",
      "mimeType": "image/png"
    },
    {
      "type": "resource",
      "resource": {
        "uri": "test://mixed-content-resource",
        "mimeType": "application/json",
        "text": "{\"test\":\"data\",\"value\":123}"
      }
    }
  ]
}
```

#### `test_tool_with_logging`

**Arguments**: None

**Behavior**: During execution, send 3 log notifications at info level:

1. "Tool execution started"
2. "Tool processing data" (after ~50ms delay)
3. "Tool execution completed" (after another ~50ms delay)

**Returns**: Text content confirming execution

**Implementation Note**: The delays are important to test that clients can receive multiple log notifications during tool execution

#### `test_tool_with_progress`

**Arguments**: None

**Behavior**: If `_meta.progressToken` is provided in request:

- Send progress notification: `0/100`
- Wait ~50ms
- Send progress notification: `50/100`
- Wait ~50ms
- Send progress notification: `100/100`

If no progress token provided, just execute with delays.

**Returns**: Text content confirming execution

**Progress Notification Format**:

```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "<from request._meta.progressToken>",
    "progress": 50,
    "total": 100
  }
}
```

#### `test_error_handling`

**Arguments**: None

**Behavior**: Always throw an error

**Returns**: JSON-RPC response with `isError: true`

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "This tool intentionally returns an error for testing"
    }
  ]
}
```

#### `test_sampling`

**Arguments**:

- `prompt` (string, required) - The prompt to send to the LLM

**Behavior**: Request LLM sampling from the client using `sampling/createMessage`

**Sampling Request**:

```json
{
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "text",
          "text": "<prompt from arguments>"
        }
      }
    ],
    "maxTokens": 100
  }
}
```

**Returns**: Text content with the LLM's response

```json
{
  "content": [
    {
      "type": "text",
      "text": "LLM response: <response from sampling>"
    }
  ]
}
```

**Implementation Note**: If the client doesn't support sampling (no `sampling` capability), return an error.

#### `test_elicitation`

**Arguments**:

- `message` (string, required) - The message to show the user

**Behavior**: Request user input from the client using `elicitation/create`

**Elicitation Request**:

```json
{
  "method": "elicitation/create",
  "params": {
    "message": "<message from arguments>",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "username": {
          "type": "string",
          "description": "User's response"
        },
        "email": {
          "type": "string",
          "description": "User's email address"
        }
      },
      "required": ["username", "email"]
    }
  }
}
```

**Returns**: Text content with the user's response

```json
{
  "content": [
    {
      "type": "text",
      "text": "User response: <action: accept/decline/cancel, content: {...}>"
    }
  ]
}
```

**Implementation Note**: If the client doesn't support elicitation (no `elicitation` capability), return an error.

#### `test_elicitation_sep1034_defaults`

**Arguments**: None

**Behavior**: Request user input from the client using `elicitation/create` with default values for all primitive types (SEP-1034)

**Elicitation Request**:

```json
{
  "method": "elicitation/create",
  "params": {
    "message": "Please review and update the form fields with defaults",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "User name",
          "default": "John Doe"
        },
        "age": {
          "type": "integer",
          "description": "User age",
          "default": 30
        },
        "score": {
          "type": "number",
          "description": "User score",
          "default": 95.5
        },
        "status": {
          "type": "string",
          "description": "User status",
          "enum": ["active", "inactive", "pending"],
          "default": "active"
        },
        "verified": {
          "type": "boolean",
          "description": "Verification status",
          "default": true
        }
      },
      "required": []
    }
  }
}
```

**Returns**: Text content with the elicitation result

```json
{
  "content": [
    {
      "type": "text",
      "text": "Elicitation completed: action=<accept/decline/cancel>, content={...}"
    }
  ]
}
```

**Implementation Note**: This tool tests SEP-1034 support for default values across all primitive types (string, integer, number, enum, boolean). If the client doesn't support elicitation (no `elicitation` capability), return an error.

**Reference**: [SEP-1034](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034)

---

## 3. Resources Requirements

### 3.1. List Resources

**Endpoint**: `resources/list`

**Requirements**:

- Return array of all available **direct resources** (not templates)
- Support optional cursor-based pagination (see Section 6.1)
- Each resource MUST have:
  - `uri` (string)
  - `name` (string)
  - `description` (string)
  - `mimeType` (string, optional)

**Note**: Resource templates are listed via separate `resources/templates/list` endpoint (see 3.1a)

### 3.1a. List Resource Templates

**Endpoint**: `resources/templates/list`

**Requirements**:

- Return array of all available **resource templates**
- Support optional cursor-based pagination (see Section 6.1)
- Each template MUST have:
  - `uriTemplate` (string) - RFC 6570 URI template
  - `name` (string)
  - `description` (string)
  - `mimeType` (string, optional)

### 3.2. Read Resource

**Endpoint**: `resources/read`

**Requirements**:

- Accept resource URI
- Return resource contents
- Response MUST have `contents` array
- Each content item MUST have `uri`, `mimeType`, and either `text` or `blob`

### 3.3. Required Resources

Implement these resources with exact URIs:

#### `test://static-text`

**Type**: Static text resource

**Metadata** (for `resources/list`):

```json
{
  "uri": "test://static-text",
  "name": "Static Text Resource",
  "description": "A static text resource for testing",
  "mimeType": "text/plain"
}
```

**Content** (for `resources/read`):

```json
{
  "contents": [
    {
      "uri": "test://static-text",
      "mimeType": "text/plain",
      "text": "This is the content of the static text resource."
    }
  ]
}
```

#### `test://static-binary`

**Type**: Static binary resource (image)

**Metadata**:

```json
{
  "uri": "test://static-binary",
  "name": "Static Binary Resource",
  "description": "A static binary resource (image) for testing",
  "mimeType": "image/png"
}
```

**Content**:

```json
{
  "contents": [
    {
      "uri": "test://static-binary",
      "mimeType": "image/png",
      "blob": "<base64-encoded-png>"
    }
  ]
}
```

#### `test://template/{id}/data`

**Type**: Resource template with parameter

**Metadata** (for `resources/list`):

```json
{
  "uriTemplate": "test://template/{id}/data",
  "name": "Resource Template",
  "description": "A resource template with parameter substitution",
  "mimeType": "application/json"
}
```

**Behavior**: When client requests `test://template/123/data`, substitute `{id}` with `123`

**Content** (for `resources/read` with `uri: "test://template/123/data"`):

```json
{
  "contents": [
    {
      "uri": "test://template/123/data",
      "mimeType": "application/json",
      "text": "{\"id\":\"123\",\"templateTest\":true,\"data\":\"Data for ID: 123\"}"
    }
  ]
}
```

**Implementation Note**: Use RFC 6570 URI template syntax

#### `test://watched-resource`

**Type**: Subscribable resource

**Metadata**:

```json
{
  "uri": "test://watched-resource",
  "name": "Watched Resource",
  "description": "A resource that can be subscribed to",
  "mimeType": "text/plain"
}
```

**Content**:

```json
{
  "contents": [
    {
      "uri": "test://watched-resource",
      "mimeType": "text/plain",
      "text": "Watched resource content"
    }
  ]
}
```

### 3.4. Resource Subscription

**Endpoint**: `resources/subscribe`

**Requirements**:

- Accept subscription request with URI
- Track subscribed URIs
- Send `notifications/resources/updated` when subscribed resources change
- Return empty object `{}`

**Example Request**:

```json
{
  "method": "resources/subscribe",
  "params": {
    "uri": "test://watched-resource"
  }
}
```

**Endpoint**: `resources/unsubscribe`

**Requirements**:

- Accept unsubscribe request with URI
- Remove URI from subscriptions
- Stop sending update notifications for that URI
- Return empty object `{}`

---

## 4. Prompts Requirements

### 4.1. List Prompts

**Endpoint**: `prompts/list`

**Requirements**:

- Return array of all available prompts
- Each prompt MUST have:
  - `name` (string)
  - `description` (string)
  - `arguments` (array, optional) - list of required arguments

### 4.2. Get Prompt

**Endpoint**: `prompts/get`

**Requirements**:

- Accept prompt name and arguments
- Return prompt messages
- Response MUST have `messages` array
- Each message MUST have `role` and `content`

### 4.3. Required Prompts

Implement these prompts with exact names:

#### `test_simple_prompt`

**Arguments**: None

**Returns**:

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "This is a simple prompt for testing."
      }
    }
  ]
}
```

#### `test_prompt_with_arguments`

**Arguments**:

- `arg1` (string, required) - First test argument
- `arg2` (string, required) - Second test argument

**Metadata** (for `prompts/list`):

```json
{
  "name": "test_prompt_with_arguments",
  "description": "A prompt with required arguments",
  "arguments": [
    {
      "name": "arg1",
      "description": "First test argument",
      "required": true
    },
    {
      "name": "arg2",
      "description": "Second test argument",
      "required": true
    }
  ]
}
```

**Returns** (with args `{arg1: "hello", arg2: "world"}`):

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "Prompt with arguments: arg1='hello', arg2='world'"
      }
    }
  ]
}
```

#### `test_prompt_with_embedded_resource`

**Arguments**:

- `resourceUri` (string, required) - URI of the resource to embed

**Returns**:

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "resource",
        "resource": {
          "uri": "<resourceUri from arguments>",
          "mimeType": "text/plain",
          "text": "Embedded resource content for testing."
        }
      }
    },
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "Please process the embedded resource above."
      }
    }
  ]
}
```

#### `test_prompt_with_image`

**Arguments**: None

**Returns**:

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "image",
        "data": "<base64-encoded-png>",
        "mimeType": "image/png"
      }
    },
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "Please analyze the image above."
      }
    }
  ]
}
```

---

## 5. Logging Requirements

### 5.1. Set Log Level

**Endpoint**: `logging/setLevel`

**Requirements**:

- Accept log level setting
- Filter subsequent log notifications based on level
- Return empty object `{}`

**Log Levels** (in order of severity):

- `debug`
- `info`
- `notice`
- `warning`
- `error`
- `critical`
- `alert`
- `emergency`

### 5.2. Log Notifications

**Notification**: `notifications/message`

**Requirements**:

- Send log notifications during operations
- Each log MUST have:
  - `level` (string) - one of the log levels above
  - `data` (any) - log message or structured data
  - `logger` (string, optional) - logger name

**Example**:

```json
{
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "conformance-test-server",
    "data": "Tool execution started"
  }
}
```

**Implementation Note**: When no client is connected, log notifications may fail. Handle this gracefully by catching promise rejections:

```typescript
mcpServer.server
  .notification({
    method: 'notifications/message',
    params: { level, logger, data }
  })
  .catch(() => {
    // Ignore error if no client is connected
  });
```

---

## 6. Pagination (Utility Feature)

### 6.1. Cursor-Based Pagination

**Purpose**: Allow servers to return large result sets in manageable chunks.

**Applies To**:

- `tools/list`
- `resources/list`
- `resources/templates/list`
- `prompts/list`

**Requirements**:

**Request Format**:

```json
{
  "method": "tools/list",
  "params": {
    "cursor": "optional-opaque-token"
  }
}
```

**Response Format**:

```json
{
  "tools": [],
  "nextCursor": "optional-opaque-token"
}
```

**Implementation Requirements**:

- If `cursor` parameter is provided, return results starting after that position
- If more results are available, include `nextCursor` in response
- Cursor tokens MUST be opaque strings (format is server-defined)
- Page size is determined by server (clients MUST NOT assume fixed page size)
- For conformance testing, pagination is optional (all items can be returned in single response)

**Example**:

```ts
// First request (no cursor)
Request: { "method": "tools/list" }
Response: {
  "tools": [/* first 10 tools */],
  "nextCursor": "page2token"
}

// Second request (with cursor)
Request: { "method": "tools/list", "params": { "cursor": "page2token" } }
Response: {
  "tools": [/* next 10 tools */],
  "nextCursor": "page3token"
}

// Last page (no nextCursor)
Request: { "method": "tools/list", "params": { "cursor": "page3token" } }
Response: {
  "tools": [/* remaining tools */]
  // No nextCursor = end of results
}
```

---

## 7. Completion Requirements

### 6.1. Complete Request

**Endpoint**: `completion/complete`

**Requirements**:

- Accept completion requests for prompt or resource template arguments
- Provide contextual suggestions based on partial input
- Return array of completion values ranked by relevance

**Request Format**:

```json
{
  "method": "completion/complete",
  "params": {
    "ref": {
      "type": "ref/prompt",
      "name": "test_prompt_with_arguments"
    },
    "argument": {
      "name": "arg1",
      "value": "par"
    }
  }
}
```

**Response Format**:

```json
{
  "completion": {
    "values": ["paris", "park", "party"],
    "total": 150,
    "hasMore": true
  }
}
```

**Implementation Note**: For conformance testing, completion support can be minimal or return empty arrays. The capability just needs to be declared and the endpoint must respond correctly.

---

## 8. Testing Your Server

### 8.1. Starting Your Server

```bash
# Example for TypeScript
cd examples/servers/typescript
npm install
npm start
```

Server should output:

```
MCP Conformance Test Server running on http://localhost:3000
  - MCP endpoint: http://localhost:3000/mcp
```

### 8.2. Running Conformance Tests

```bash
# Single test
npm run start -- server --url http://localhost:3000/mcp --scenario server-initialize

# All tests
npm run start -- server --url http://localhost:3000/mcp
```
