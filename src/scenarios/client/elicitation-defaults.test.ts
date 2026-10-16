import { describe, expect, test } from 'vitest';
import { testScenarioContext } from '../../mock-server/testing';
import { ElicitationClientDefaultsScenario } from './elicitation-defaults';

const acceptHeader = 'application/json, text/event-stream';

function requestHeaders(
  protocolVersion: string,
  sessionId?: string
): HeadersInit {
  return {
    Accept: acceptHeader,
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': protocolVersion,
    ...(sessionId ? { 'MCP-Session-Id': sessionId } : {})
  };
}

async function readUntilElicitation(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  let body = '';
  const timeout = setTimeout(() => {
    void reader.cancel();
  }, 1_000);
  try {
    while (!body.includes('elicitation/create')) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      body += new TextDecoder().decode(value);
    }
    return body;
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
}

async function readJsonRpcResult(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return response.json();
  }

  const body = await response.text();
  const data = body.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!data) {
    throw new Error('Expected a JSON-RPC event in the response stream');
  }
  return JSON.parse(data.slice('data:'.length).trim());
}

async function waitForResponse(
  response: Promise<Response | null>,
  timeoutMs: number
): Promise<Response | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe('elicitation defaults client scenario', () => {
  test('sends elicitation on the originating tool-call response stream', async () => {
    const scenario = new ElicitationClientDefaultsScenario();
    const context = testScenarioContext('2025-11-25');
    const { serverUrl } = await scenario.start(context);

    try {
      const initializeResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          Accept: acceptHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: context.specVersion,
            capabilities: {
              elicitation: {
                form: {
                  applyDefaults: true
                }
              }
            },
            clientInfo: { name: 'stream-test-client', version: '1.0.0' }
          }
        })
      });
      expect(initializeResponse.ok).toBe(true);
      const sessionId = initializeResponse.headers.get('MCP-Session-Id');
      expect(sessionId).toBeTruthy();
      await readJsonRpcResult(initializeResponse);

      await fetch(serverUrl, {
        method: 'POST',
        headers: requestHeaders(context.specVersion, sessionId!),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });

      const toolsResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: requestHeaders(context.specVersion, sessionId!),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        })
      });
      expect(toolsResponse.ok).toBe(true);
      const toolsResult = (await readJsonRpcResult(toolsResponse)) as {
        result?: { tools?: Array<{ name: string }> };
      };
      expect(toolsResult.result?.tools?.map((tool) => tool.name)).toContain(
        'test_client_elicitation_defaults'
      );

      const controller = new AbortController();
      const callResponse = await waitForResponse(
        fetch(serverUrl, {
          method: 'POST',
          headers: requestHeaders(context.specVersion, sessionId!),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'test_client_elicitation_defaults',
              arguments: {}
            }
          }),
          signal: controller.signal
        }).catch(() => null),
        2_000
      );

      if (!callResponse) {
        controller.abort();
        throw new Error('Timed out waiting for the tool-call response stream');
      }

      try {
        expect(await readUntilElicitation(callResponse)).toContain(
          'elicitation/create'
        );
      } finally {
        controller.abort();
      }
    } finally {
      await scenario.stop();
    }
  });
});
