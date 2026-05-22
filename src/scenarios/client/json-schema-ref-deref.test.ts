import { describe, test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { JsonSchemaRefDerefScenario } from './json-schema-ref-deref';
import { getScenario } from '../index';

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

  test('dereferencing client fails: canary fetch is detected', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(dereferencingClient),
      'json-schema-ref-no-deref',
      { expectedFailureSlugs: ['sep-2106-no-network-ref-deref'] }
    );
  });

  test('client that never lists tools fails: requirement cannot be evaluated', async () => {
    const scenario = new JsonSchemaRefDerefScenario();
    await scenario.start();
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
