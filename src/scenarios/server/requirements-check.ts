/**
 * Capability and fixture requirement evaluation for server-conformance scenarios.
 *
 * In default SDK conformance mode (`--production` omitted), scenarios execute
 * unconditionally so SDK reference servers cannot pass by omitting features
 * (issues #248, #372). In opt-in `--production` mode, the runner evaluates
 * each scenario's declarative `requires` metadata against the server's
 * advertised capabilities and emits `SKIPPED` checks for undeclared optional
 * capabilities/extensions or reference-fixture contracts.
 */

import type {
  ConformanceCheck,
  ExtensionId,
  ScenarioRequirements,
  ServerCapability
} from '../../types';

export type SkippedRequirementReason =
  | 'missing-capability'
  | 'missing-extension'
  | 'requires-fixture';

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `capabilities` declares `capability`.
 *
 * Checks key presence (`!== undefined`) for top-level capability objects so a
 * malformed declaration (e.g. `resources: true`) is still treated as declared
 * and allowed to fail wire/scenario validation rather than silently skipping.
 */
export function hasServerCapability(
  capabilities: Record<string, unknown>,
  capability: ServerCapability
): boolean {
  if (capability === 'resources.subscribe') {
    return (
      isPlainObject(capabilities.resources) &&
      Boolean(capabilities.resources.subscribe)
    );
  }
  return capability in capabilities && capabilities[capability] !== undefined;
}

/**
 * Whether `capabilities.extensions` declares `extensionId`.
 */
export function hasServerExtension(
  capabilities: Record<string, unknown>,
  extensionId: ExtensionId
): boolean {
  if (!isPlainObject(capabilities.extensions)) {
    return false;
  }
  return (
    extensionId in capabilities.extensions &&
    capabilities.extensions[extensionId] !== undefined
  );
}

function buildSkippedCheck(
  scenarioName: string,
  description: string,
  skippedReason: SkippedRequirementReason,
  extraDetails: Record<string, unknown>
): ConformanceCheck {
  return {
    id: scenarioName,
    name: scenarioName,
    description,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    details: {
      skippedReason,
      ...extraDetails
    }
  };
}

function formatQuotedList(items: readonly string[]): string {
  return items.map((item) => `'${item}'`).join(', ');
}

/**
 * Evaluate a scenario's `requires` metadata against the server's declared
 * `capabilities` in `--production` mode.
 *
 * Returns a `SKIPPED` check when a prerequisite is unmet, or `null` when all
 * prerequisites are satisfied and the scenario should execute.
 */
export function evaluateScenarioRequirements(
  scenarioName: string,
  requires: ScenarioRequirements | undefined,
  capabilities: Record<string, unknown>
): ConformanceCheck | null {
  if (!requires) {
    return null;
  }

  const missingCaps = (requires.capabilities ?? []).filter(
    (cap) => !hasServerCapability(capabilities, cap)
  );
  if (missingCaps.length > 0) {
    return buildSkippedCheck(
      scenarioName,
      `Skipped in production mode: server did not declare required capability ${formatQuotedList(missingCaps)}`,
      'missing-capability',
      { missingCapabilities: missingCaps }
    );
  }

  if (
    requires.anyCapability &&
    requires.anyCapability.length > 0 &&
    !requires.anyCapability.some((cap) =>
      hasServerCapability(capabilities, cap)
    )
  ) {
    return buildSkippedCheck(
      scenarioName,
      `Skipped in production mode: server did not declare any of ${formatQuotedList(requires.anyCapability)}`,
      'missing-capability',
      { requiredAnyOf: [...requires.anyCapability] }
    );
  }

  const missingExts = (requires.extensions ?? []).filter(
    (ext) => !hasServerExtension(capabilities, ext)
  );
  if (missingExts.length > 0) {
    return buildSkippedCheck(
      scenarioName,
      `Skipped in production mode: server did not declare required extension ${formatQuotedList(missingExts)}`,
      'missing-extension',
      { missingExtensions: missingExts }
    );
  }

  if (requires.fixture) {
    return buildSkippedCheck(
      scenarioName,
      `Skipped in production mode: scenario '${scenarioName}' requires reference-fixture artifacts (test_* / test://)`,
      'requires-fixture',
      { scenario: scenarioName }
    );
  }

  return null;
}
