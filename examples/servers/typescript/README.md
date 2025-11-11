# MCP Conformance Test Server

A reference implementation of an MCP server that implements all features required for conformance testing.

## Features

This server implements:

### Tools

- `test_simple_text` - Returns simple text content
- `test_image_content` - Returns image content (base64 PNG)
- `test_audio_content` - Returns audio content (base64 WAV)
- `test_embedded_resource` - Returns embedded resource
- `test_multiple_content_types` - Returns mixed content types
- `test_tool_with_logging` - Emits log messages during execution
- `test_tool_with_progress` - Reports progress notifications
- `test_error_handling` - Returns error response
- `test_sampling` - Requests LLM completion from client
- `test_elicitation` - Requests user input from client
- `test_dynamic_tool` - Dynamically added/removed tool

### Resources

- `test://static-text` - Static text resource
- `test://static-binary` - Static binary resource (image)
- `test://template/{id}/data` - Resource template with parameter
- `test://watched-resource` - Subscribable resource with updates

### Prompts

- `test_simple_prompt` - Simple prompt without arguments
- `test_prompt_with_arguments(arg1, arg2)` - Parameterized prompt
- `test_prompt_with_embedded_resource(resourceUri)` - Prompt with embedded resource
- `test_prompt_with_image` - Prompt with image content

### Other Capabilities

- Logging at all levels (debug, info, notice, warning, error, critical, alert, emergency)
- Completion support for prompt and resource arguments
- List changed notifications for tools, resources, and prompts
- Resource subscription and update notifications

## Installation

```bash
npm install
```

## Running the Server

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `PORT` environment variable).

## Endpoints

### MCP Endpoint

- `POST /mcp` - Main MCP protocol endpoint

### Health Check

- `GET /health` - Server health check

## Automatic Behaviors

The server automatically demonstrates dynamic capabilities:

- **Dynamic Tool** - `test_dynamic_tool` is automatically added 2 seconds after server starts
- **Dynamic Resource** - `test://dynamic-resource` is automatically added 2 seconds after server starts
- **Dynamic Prompt** - `test_dynamic_prompt` is automatically added 2 seconds after server starts
- **Resource Updates** - `test://watched-resource` automatically updates every 3 seconds with new content

These behaviors allow testing of MCP notifications without requiring manual triggers.

## Example Usage

### Starting the Server

```bash
npm start
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

### Testing with curl

#### Initialize

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

#### List Tools

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

#### Call Tool

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "test_simple_text",
      "arguments": {}
    }
  }'
```

## Conformance Testing

This server implements the MCP Server Conformance Requirements specified in `../../../SERVER_REQUIREMENTS.md`. All tools, resources, and prompts use standardized naming conventions for consistent testing across SDK implementations.

To run conformance tests against this server:

```bash
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp
```

## Implementation Notes

- All tool, resource, and prompt names follow the standardized naming conventions (`test_*` for tools/prompts, `test://` for resources)
- Names are descriptive of the feature being tested (e.g., `test_image_content`, `test_tool_with_progress`)
- The server uses the TypeScript MCP SDK (`@modelcontextprotocol/sdk`) high-level API
- Uses `registerTool()`, `registerResource()`, and `registerPrompt()` methods
- Transport is Streamable HTTP (Express) for web-based testing compatibility
- Promise rejections from notifications are caught and handled gracefully

## For SDK Implementers

If you're implementing MCP in another language/SDK:

1. **Read the Requirements**: See `../../../SERVER_REQUIREMENTS.md` for complete specifications
2. **Use This as Reference**: This TypeScript implementation demonstrates all required features
3. **Follow Naming Conventions**: Use exact tool/resource/prompt names specified in requirements
4. **Implement Automatic Behaviors**: Dynamic registration after 2s, resource updates every 3s
5. **Handle Notifications Carefully**: Catch/ignore errors when no client is connected

**Goal**: All SDK example servers provide the same interface, enabling a single test suite to verify conformance across all implementations.
