# Using MCP Conformance Tests in SDK Repositories

This guide explains how to integrate the MCP conformance test suite into your language SDK repository. The conformance framework tests your MCP implementation against the protocol specification to ensure compatibility.

## Quick Start

Install and run conformance tests:

```bash
# Client testing (framework starts a test server, runs your client against it)
npx @modelcontextprotocol/conformance client --command "your-client-command" --scenario initialize

# Server testing (your server must already be running)
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --scenario server-initialize
```

## Two Testing Modes

### Client Testing

The framework **starts a test server** and spawns your client against it. Your client receives the server URL as its final command-line argument.

```bash
# Run a single scenario
npx @modelcontextprotocol/conformance client \
  --command "python tests/conformance/client.py" \
  --scenario initialize

# Run a suite of tests
npx @modelcontextprotocol/conformance client \
  --command "python tests/conformance/client.py" \
  --suite auth
```

**Available client suites:** `all`, `core`, `extensions`, `auth`, `metadata`, `sep-835`

Your client should:

1. Accept the server URL as its last argument
2. Read `MCP_CONFORMANCE_SCENARIO` env var to determine which scenario is being tested
3. Read `MCP_CONFORMANCE_CONTEXT` env var for scenario-specific data (e.g., OAuth credentials)

### Server Testing

Your server must be **running before** invoking the conformance tool. The framework connects to it as an MCP client.

```bash
# Start your server first
your-server --port 3001 &

# Then run conformance tests
npx @modelcontextprotocol/conformance server \
  --url http://localhost:3001/mcp \
  --suite active
```

**Available server suites:** `active` (default), `all`, `pending`

**Note:** Server testing requires you to manage server lifecycle (start, health-check, cleanup) yourself.

---

## Expected Failures (Baseline) File

The expected-failures feature lets your CI pass while you work on fixing known issues. It catches regressions by failing when:

- A previously passing test starts failing (regression)
- A previously failing test starts passing (stale baseline - remove the entry)

### File Format

Create a YAML file (e.g., `conformance-baseline.yml`):

```yaml
server:
  - tools-call-with-progress
  - resources-subscribe
client:
  - auth/client-credentials-jwt
```

### Usage

```bash
npx @modelcontextprotocol/conformance server \
  --url http://localhost:3000/mcp \
  --expected-failures ./conformance-baseline.yml
```

### Exit Code Behavior

| Scenario Result | In Baseline? | Exit Code | Meaning                       |
| --------------- | ------------ | --------- | ----------------------------- |
| Fails           | Yes          | 0         | Expected failure              |
| Fails           | No           | 1         | Unexpected regression         |
| Passes          | Yes          | 1         | Stale baseline - remove entry |
| Passes          | No           | 0         | Normal pass                   |

---

## GitHub Action

The conformance repo provides a reusable GitHub Action that handles Node.js setup and conformance execution.

### Client Testing Example

```yaml
name: Conformance Tests
on: [push, pull_request]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up your SDK
        run: |
          # Your SDK setup (pip install, npm install, etc.)
          pip install -e .

      - uses: modelcontextprotocol/conformance@v0.1.10
        with:
          mode: client
          command: 'python tests/conformance/client.py'
          suite: auth
          expected-failures: ./conformance-baseline.yml
```

### Server Testing Example

```yaml
name: Conformance Tests
on: [push, pull_request]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up and start server
        run: |
          pip install -e .
          python -m myserver --port 3001 &
          # Wait for server to be ready
          timeout 15 bash -c 'until curl -s http://localhost:3001/mcp; do sleep 0.5; done'

      - uses: modelcontextprotocol/conformance@v0.1.10
        with:
          mode: server
          url: http://localhost:3001/mcp
          suite: active
          expected-failures: ./conformance-baseline.yml
```

### Action Inputs

| Input               | Required    | Description                                     |
| ------------------- | ----------- | ----------------------------------------------- |
| `mode`              | Yes         | `server` or `client`                            |
| `url`               | Server mode | URL of the server to test                       |
| `command`           | Client mode | Command to run the client                       |
| `expected-failures` | No          | Path to YAML baseline file                      |
| `suite`             | No          | Test suite to run                               |
| `scenario`          | No          | Run a single scenario by name                   |
| `timeout`           | No          | Timeout in ms for client tests (default: 30000) |
| `verbose`           | No          | Show verbose output (default: false)            |
| `node-version`      | No          | Node.js version (default: 20)                   |

---

## Writing Conformance Clients/Servers

### Example Client Pattern

See [`src/conformance/everything-client.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/conformance/everything-client.ts) in the TypeScript SDK for a reference implementation. The recommended pattern is a single client that routes behavior based on the scenario:

```python
import os
import sys
import json

def main():
    server_url = sys.argv[-1]  # URL passed as last argument
    scenario = os.environ.get("MCP_CONFORMANCE_SCENARIO", "")
    context = json.loads(os.environ.get("MCP_CONFORMANCE_CONTEXT", "{}"))

    if scenario.startswith("auth/"):
        run_auth_scenario(server_url, scenario, context)
    else:
        run_default_scenario(server_url)

if __name__ == "__main__":
    main()
```

### Example Server Pattern

See [`src/conformance/everything-server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/conformance/everything-server.ts) in the TypeScript SDK for a reference implementation that handles all server scenarios.

### SEP-2350 Request-Time Scope Challenge Fixture

The draft server scenario `sep-2350-server-scope-challenge` tests request-time
OAuth `insufficient_scope` behavior without prescribing a token format or
requiring an authorization server. Conformance fixtures use two opaque tokens:

- `mcp-conformance-scope-low` is valid and has only
  `mcp:conformance:baseline`.
- `mcp-conformance-scope-full` is valid and has every scope in the table below.

Keep requests without these fixture tokens unchanged so the existing server
scenarios continue to exercise unauthenticated fixtures.

| Operation                 | Existing fixture           | Scopes required in one challenge                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `tools/call`              | `test_simple_text`         | `mcp:conformance:tools:call mcp:conformance:tools:test_simple_text`      |
| Static `resources/read`   | `test://static-text`       | `mcp:conformance:resources:read mcp:conformance:resources:static`        |
| Template `resources/read` | `test://template/123/data` | `mcp:conformance:resources:read mcp:conformance:resources:template:123`  |
| `prompts/get`             | `test_simple_prompt`       | `mcp:conformance:prompts:get mcp:conformance:prompts:test_simple_prompt` |

For the low token, each operation returns HTTP 403 with a Bearer
`WWW-Authenticate` challenge containing `error="insufficient_scope"`,
`scope` containing both listed scopes, and a quoted, absolute
`resource_metadata` URL. The URL may be an explicitly advertised metadata
location, the root well-known location, or the RFC 9728 path-derived location:

```text
{server origin}/.well-known/oauth-protected-resource{server path}
```

For example, a server URL of `http://localhost:3000/mcp` may use
`http://localhost:3000/.well-known/oauth-protected-resource/mcp` or
`http://localhost:3000/.well-known/oauth-protected-resource`. Path-derived
locations preserve a meaningful trailing path slash and query component.
Parameter and scope ordering are not significant, and the server may include
additional scopes. Retrying the same operation with the full token must return
its normal successful MCP result. Protected-resource metadata discovery and
document-content checks remain covered by the authorization discovery
scenarios.

These static tokens are test inputs only. Production servers should use their
normal access-token verification, and this fixture does not replace the
separate conformance work for token validation or authorization-server
integration.

---

## Additional Resources

- [Conformance README](./README.md)
- [Design documentation](./src/runner/DESIGN.md)
- [TypeScript SDK conformance examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/src/conformance)
