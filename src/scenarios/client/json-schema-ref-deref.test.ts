import { testScenarioContext } from '../../mock-server/testing';
import { describe, test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { JsonSchemaRefDerefScenario } from './json-schema-ref-deref';
import { getScenario } from '../index';
import { sendStatelessRequest } from '../../connection/stateless';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

/**
 * SEP-2106: implementations MUST NOT automatically dereference $ref values
 * that resolve to a network URI.
 *
 * Positive: a compliant client lists tools and never touches the canary URL.
 * Negative: a client that walks tool schemas and fetches network $refs must
 * produce a FAILURE for sep-2106-no-network-ref-deref.
 */

/** Recursively collect string `$ref` values that look like network URIs. */
function collectNetworkRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectNetworkRefs(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (
        key === '$ref' &&
        typeof value === 'string' &&
        /^https?:/.test(value)
      ) {
        out.push(value);
      } else {
        collectNetworkRefs(value, out);
      }
    }
  }
  return out;
}

async function compliantClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  await client.listTools();
  await transport.close();
}

async function dereferencingClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'deref-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  const result = await client.listTools();

  // Naive schema processing: resolve every $ref, including network URIs.
  // This is exactly the behavior SEP-2106 forbids.
  for (const tool of result.tools ?? []) {
    for (const ref of collectNetworkRefs(tool.inputSchema)) {
      await fetch(ref);
    }
  }

  await transport.close();
}

/**
 * SEP-2575 stateless client: probe `server/discover` first, then honor the
 * negotiated protocol version on subsequent requests. Regression client for
 * issue #397 — the scenario's hand-rolled `server/discover` advertises the
 * draft version, so the pinned SDK transport must not reject that version's
 * MCP-Protocol-Version header on the follow-up tools/list.
 */
async function statelessDraftClient(serverUrl: string): Promise<void> {
  const discover = await sendStatelessRequest(serverUrl, 'server/discover');
  const supportedVersions = (
    discover.body?.result as { supportedVersions?: string[] } | undefined
  )?.supportedVersions;
  if (!supportedVersions?.includes(DRAFT_PROTOCOL_VERSION)) {
    throw new Error(
      `server/discover did not advertise ${DRAFT_PROTOCOL_VERSION}: ` +
        JSON.stringify(supportedVersions)
    );
  }

  // sendStatelessRequest sends MCP-Protocol-Version: <draft> by default —
  // exactly what a client that honors the negotiated version would do.
  const tools = await sendStatelessRequest(serverUrl, 'tools/list');
  if (tools.status !== 200 || tools.body?.result === undefined) {
    throw new Error(
      `tools/list with the negotiated draft version failed: HTTP ${tools.status} ` +
        JSON.stringify(tools.body ?? tools.text)
    );
  }
}

describe('json-schema-ref-no-deref (SEP-2106)', () => {
  test('scenario is registered', () => {
    expect(getScenario('json-schema-ref-no-deref')).toBeDefined();
  });

  test('compliant client passes: network $ref is not fetched', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(compliantClient),
      'json-schema-ref-no-deref'
    );
  });

  test('stateless draft client passes: negotiated version reaches tools/list (issue #397)', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(statelessDraftClient),
      'json-schema-ref-no-deref'
    );
  });

  test('dereferencing client fails: canary fetch is detected', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(dereferencingClient),
      'json-schema-ref-no-deref',
      { expectedFailureSlugs: ['sep-2106-no-network-ref-deref'] }
    );
  });

  test('client that never lists tools fails: requirement cannot be evaluated', async () => {
    const scenario = new JsonSchemaRefDerefScenario();
    await scenario.start(testScenarioContext());
    try {
      const checks = scenario.getChecks();
      const check = checks.find(
        (c) => c.id === 'sep-2106-no-network-ref-deref'
      );
      expect(check?.status).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  });
});
