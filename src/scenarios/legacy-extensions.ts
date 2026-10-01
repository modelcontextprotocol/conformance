import { isDeepStrictEqual } from 'node:util';
import type { ConformanceCheck } from '../types';

// Diagnostic fixtures, not a claim of full Apps conformance. The example.com
// extension exercises arbitrary settings that an SDK cannot know in advance.
export const LEGACY_EXTENSION_VERSION = '2025-11-25';
export const CLIENT_EXTENSIONS = {
  'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  'com.example/conformance': {
    nested: { enabled: false, limit: 0 },
    values: ['a', 2, null]
  },
  'com.example/empty': {}
};
export const SERVER_EXTENSIONS = {
  'io.modelcontextprotocol/ui': {},
  'com.example/conformance': {
    nested: { enabled: true, limit: 3 },
    values: [null, 'b', 4]
  },
  'com.example/empty': {}
};
export const EXTENSIONS_ECHO_TOOL = 'test_legacy_extension_capabilities';
export const EXTENSION_REFERENCES = [
  {
    id: 'SEP-2133-Negotiation',
    url: 'https://modelcontextprotocol.io/seps/2133-extensions#negotiation'
  },
  {
    id: 'Legacy-Extension-Negotiation',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3364'
  }
];

export function extensionChecks(
  direction: string,
  actual: unknown,
  expected: Record<string, unknown>
): ConformanceCheck[] {
  return Object.entries(expected).map(([key, value]) => {
    const received =
      actual !== null && typeof actual === 'object'
        ? (actual as Record<string, unknown>)[key]
        : undefined;
    const preserved = isDeepStrictEqual(received, value);
    return {
      id: `legacy-extensions-${direction}-${key.split('/')[1]}`,
      name: 'LegacyExtensionPreservation',
      description: `${direction}: preserve ${key} and its settings`,
      status: preserved ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      specReferences: EXTENSION_REFERENCES,
      errorMessage: preserved
        ? undefined
        : `Missing or altered extension ${key}`,
      details: { expected: value, actual: received }
    };
  });
}
