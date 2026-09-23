/** Deliberately broken clients used by the legacy extension negative controls. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CLIENT_EXTENSIONS,
  EXTENSIONS_ECHO_TOOL
} from '../../../src/scenarios/legacy-extensions.js';

export async function runBrokenLegacyClient(
  url: string,
  mode: 'advertisement' | 'reception' | 'settings' | 'missing-report'
) {
  const client = new Client(
    { name: 'broken-extensions-client', version: '1.0.0' },
    {
      capabilities:
        mode === 'advertisement' ? {} : { extensions: CLIENT_EXTENSIONS }
    }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    if (mode === 'missing-report') return;
    const extensions = structuredClone(
      client.getServerCapabilities()?.extensions ?? {}
    );
    if (mode === 'settings') extensions['com.example/conformance'] = {};
    await client.callTool({
      name: EXTENSIONS_ECHO_TOOL,
      arguments: { extensions: mode === 'reception' ? {} : extensions }
    });
  } finally {
    await client.close();
  }
}
