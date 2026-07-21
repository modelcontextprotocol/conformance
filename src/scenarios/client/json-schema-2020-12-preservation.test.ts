import { testScenarioContext } from '../../mock-server/testing';
import { createServerStateful } from '../../mock-server/stateful';
import type { ScenarioContext } from '../../mock-server';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JsonSchema2020_12PreservationScenario } from './json-schema-2020-12-preservation';
import {
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION,
  type SpecVersion
} from '../../types';
import { JSON_SCHEMA_2020_12_FIXTURE } from '../server/json-schema-2020-12';

/**
 * Build a ScenarioContext whose advertised spec version drives the
 * scenario's soft-gating logic, while the underlying mock server stays on
 * the stateful (initialize-handshake) lifecycle. The SDK `Client` does not
 * yet support the SEP-2575 stateless lifecycle, so a stateless mock server
 * cannot be driven by the SDK in this unit test; this helper lets us
 * exercise the SEP-2106 draft-target branch without that limitation.
 */
function statefulCtxAtSpecVersion(specVersion: SpecVersion): ScenarioContext {
  return {
    specVersion,
    createServer: createServerStateful
  };
}

const FOCAL_TOOL = 'json_schema_2020_12_tool';
const ECHO_TOOL = 'json_schema_echo';

/**
 * Connect a real SDK client to the scenario's mock server, list tools, and
 * echo back the focal tool's inputSchema (verbatim or after the caller-
 * supplied transform). Returns nothing — the scenario observes the echo
 * internally.
 */
async function runEchoClient(
  serverUrl: string,
  transform: (schema: Record<string, unknown>) => Record<string, unknown> = (
    s
  ) => s
): Promise<void> {
  const client = new Client(
    { name: 'preservation-test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const focal = listed.tools.find((t) => t.name === FOCAL_TOOL);
    if (!focal) {
      throw new Error(`Focal tool ${FOCAL_TOOL} not advertised`);
    }
    const observed = focal.inputSchema as Record<string, unknown>;
    await client.callTool({
      name: ECHO_TOOL,
      arguments: { schema: transform(observed) }
    });
  } finally {
    await transport.close();
  }
}

describe('json-schema-2020-12-preservation scenario', () => {
  it('emits FAILURE preconditions and SKIPPED preservation checks when no client connects', async () => {
    const scenario = new JsonSchema2020_12PreservationScenario();
    await scenario.start(testScenarioContext());
    try {
      const checks = scenario.getChecks();
      expect(checks).toHaveLength(8);
      expect(
        checks.find((c) => c.id === 'json-schema-2020-12-client-tool-found')
          ?.status
      ).toBe('FAILURE');
      expect(
        checks.find((c) => c.id === 'json-schema-2020-12-client-echo-completed')
          ?.status
      ).toBe('FAILURE');
      const preservationIds = [
        'json-schema-2020-12-client-$schema-preserved',
        'json-schema-2020-12-client-$defs-preserved',
        'json-schema-2020-12-client-additionalProperties-preserved',
        'sep-2106-client-composition-keywords-preserved',
        'sep-2106-client-conditional-keywords-preserved',
        'sep-2106-client-anchor-keyword-preserved'
      ];
      for (const id of preservationIds) {
        expect(checks.find((c) => c.id === id)?.status).toBe('SKIPPED');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('emits SUCCESS for SEP-1613 keywords and SKIPPED for SEP-2106 when a compliant client echoes back on a dated target', async () => {
    const scenario = new JsonSchema2020_12PreservationScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(LATEST_SPEC_VERSION)
    );
    try {
      await runEchoClient(serverUrl);

      const first = scenario.getChecks();
      expect(first).toHaveLength(8);
      const byId = (id: string) =>
        first.find((c) => c.id === id) ?? expect.fail(`missing check ${id}`);
      expect(byId('json-schema-2020-12-client-tool-found').status).toBe(
        'SUCCESS'
      );
      expect(byId('json-schema-2020-12-client-echo-completed').status).toBe(
        'SUCCESS'
      );
      expect(byId('json-schema-2020-12-client-$schema-preserved').status).toBe(
        'SUCCESS'
      );
      expect(byId('json-schema-2020-12-client-$defs-preserved').status).toBe(
        'SUCCESS'
      );
      expect(
        byId('json-schema-2020-12-client-additionalProperties-preserved').status
      ).toBe('SUCCESS');
      // SEP-2106 keywords were preserved (compliant client), so the soft gate
      // returns SUCCESS regardless of target version.
      expect(
        byId('sep-2106-client-composition-keywords-preserved').status
      ).toBe('SUCCESS');
      expect(
        byId('sep-2106-client-conditional-keywords-preserved').status
      ).toBe('SUCCESS');
      expect(byId('sep-2106-client-anchor-keyword-preserved').status).toBe(
        'SUCCESS'
      );

      // getChecks() must be idempotent — duplicate IDs would break the
      // traceability manifest.
      expect(scenario.getChecks()).toHaveLength(8);
    } finally {
      await scenario.stop();
    }
  });

  it('emits all SUCCESS when a compliant client echoes back on the draft target', async () => {
    const scenario = new JsonSchema2020_12PreservationScenario();
    const { serverUrl } = await scenario.start(
      statefulCtxAtSpecVersion(DRAFT_PROTOCOL_VERSION)
    );
    try {
      await runEchoClient(serverUrl);

      const checks = scenario.getChecks();
      for (const c of checks) {
        expect(c.status, `check ${c.id}`).toBe('SUCCESS');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('flags SEP-1613 FAILURE when a client strips $schema and $defs before echoing', async () => {
    const scenario = new JsonSchema2020_12PreservationScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(LATEST_SPEC_VERSION)
    );
    try {
      await runEchoClient(serverUrl, (schema) => {
        const stripped = { ...schema };
        delete stripped['$schema'];
        delete stripped['$defs'];
        return stripped;
      });

      const checks = scenario.getChecks();
      const byId = (id: string) =>
        checks.find((c) => c.id === id) ?? expect.fail(`missing check ${id}`);

      expect(byId('json-schema-2020-12-client-tool-found').status).toBe(
        'SUCCESS'
      );
      expect(byId('json-schema-2020-12-client-echo-completed').status).toBe(
        'SUCCESS'
      );
      expect(byId('json-schema-2020-12-client-$schema-preserved').status).toBe(
        'FAILURE'
      );
      expect(byId('json-schema-2020-12-client-$defs-preserved').status).toBe(
        'FAILURE'
      );
      // additionalProperties was left intact, so it still passes.
      expect(
        byId('json-schema-2020-12-client-additionalProperties-preserved').status
      ).toBe('SUCCESS');
      // $anchor lives inside the stripped $defs, so it's also missing — but
      // the soft gate is SKIPPED on the dated target rather than FAILURE.
      expect(byId('sep-2106-client-anchor-keyword-preserved').status).toBe(
        'SKIPPED'
      );
    } finally {
      await scenario.stop();
    }
  });

  it('flags SEP-2106 FAILURE on the draft target when composition keywords are stripped', async () => {
    const scenario = new JsonSchema2020_12PreservationScenario();
    const { serverUrl } = await scenario.start(
      statefulCtxAtSpecVersion(DRAFT_PROTOCOL_VERSION)
    );
    try {
      await runEchoClient(serverUrl, (schema) => {
        const stripped = { ...schema };
        delete stripped['allOf'];
        delete stripped['anyOf'];
        delete stripped['if'];
        delete stripped['then'];
        delete stripped['else'];
        return stripped;
      });

      const checks = scenario.getChecks();
      const byId = (id: string) =>
        checks.find((c) => c.id === id) ?? expect.fail(`missing check ${id}`);

      expect(byId('json-schema-2020-12-client-$schema-preserved').status).toBe(
        'SUCCESS'
      );
      expect(
        byId('sep-2106-client-composition-keywords-preserved').status
      ).toBe('FAILURE');
      expect(
        byId('sep-2106-client-conditional-keywords-preserved').status
      ).toBe('FAILURE');
      // $anchor is preserved inside $defs.address, which was left intact.
      expect(byId('sep-2106-client-anchor-keyword-preserved').status).toBe(
        'SUCCESS'
      );
    } finally {
      await scenario.stop();
    }
  });

  it('preserves the focal fixture verbatim through the echo when the client does not transform it', async () => {
    // Sanity check that the round-trip itself does not introduce drift; if
    // this fails, all the other tests are unreliable.
    const scenario = new JsonSchema2020_12PreservationScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runEchoClient(serverUrl);
      const checks = scenario.getChecks();
      const preserved = checks.find(
        (c) => c.id === 'json-schema-2020-12-client-$defs-preserved'
      );
      expect(preserved?.details).toMatchObject({
        hasDefs: true,
        defsKeys: Object.keys(JSON_SCHEMA_2020_12_FIXTURE['$defs'])
      });
    } finally {
      await scenario.stop();
    }
  });
});
