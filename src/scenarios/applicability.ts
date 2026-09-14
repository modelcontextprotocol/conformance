import {
  type DatedSpecVersion,
  type ScenarioSource,
  type SpecVersion,
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
} from '../types';

// Which spec versions a scenario applies to, kept apart from ./index so code
// that asks (the requirement sets, the hosted matrix) does not load every
// scenario module with the registry.

// All valid spec versions, used by the CLI to validate --spec-version input.
// 'extension' is intentionally excluded — extension scenarios are off-timeline
// and selected via `--suite extensions`, not `--spec-version`.
export const ALL_SPEC_VERSIONS: SpecVersion[] = [
  ...DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
];

function versionIndex(
  v: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION
): number {
  return ALL_SPEC_VERSIONS.indexOf(v);
}

// Off-timeline sources (extensions etc.) are never selected by --spec-version.
export function matchesSpecVersion(
  source: ScenarioSource,
  version: SpecVersion
): boolean {
  if ('extensionId' in source) return false;
  return (
    versionIndex(source.introducedIn) <= versionIndex(version) &&
    (source.removedIn === undefined ||
      versionIndex(version) < versionIndex(source.removedIn))
  );
}

/**
 * Whether a scenario's applicability window covers `version`. Used by the
 * runner to skip explicitly-requested scenario/spec-version combinations
 * that contradict (e.g. a draft-only scenario at a dated spec version).
 */
export function isScenarioApplicableAt(
  source: ScenarioSource,
  version: SpecVersion
): boolean {
  return matchesSpecVersion(source, version);
}
