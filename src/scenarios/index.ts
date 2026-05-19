import {
  Scenario,
  ClientScenario,
  ClientScenarioForAuthorizationServer,
  ScenarioSource,
  SpecVersion,
  DatedSpecVersion,
  ScenarioSpecTag,
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
} from '../types';
import { InitializeScenario } from './client/initialize';
import { ToolsCallScenario } from './client/tools_call';
import { ElicitationClientDefaultsScenario } from './client/elicitation-defaults';
import { SSERetryScenario } from './client/sse-retry';
import { RequestMetadataScenario } from './client/request-metadata';

// Import all new server test scenarios
import { ServerInitializeScenario } from './server/lifecycle';
import { ServerProtocolVersionHeaderScenario } from './server/protocol-version-header';

import {
  PingScenario,
  LoggingSetLevelScenario,
  CompletionCompleteScenario
} from './server/utils';

import {
  ToolsListScenario,
  ToolsCallSimpleTextScenario,
  ToolsCallImageScenario,
  ToolsCallMultipleContentTypesScenario,
  ToolsCallWithLoggingScenario,
  ToolsCallErrorScenario,
  ToolsCallWithProgressScenario,
  ToolsCallSamplingScenario,
  ToolsCallElicitationScenario,
  ToolsCallAudioScenario,
  ToolsCallEmbeddedResourceScenario
} from './server/tools';

import { JsonSchema2020_12Scenario } from './server/json-schema-2020-12';

import { ElicitationDefaultsScenario } from './server/elicitation-defaults';
import { ElicitationEnumsScenario } from './server/elicitation-enums';
import { ServerSSEPollingScenario } from './server/sse-polling';
import { ServerSSEMultipleStreamsScenario } from './server/sse-multiple-streams';

import {
  ResourcesListScenario,
  ResourcesReadTextScenario,
  ResourcesReadBinaryScenario,
  ResourcesTemplateReadScenario,
  ResourcesSubscribeScenario,
  ResourcesUnsubscribeScenario,
  ResourcesNotFoundErrorScenario
} from './server/resources';

import {
  PromptsListScenario,
  PromptsGetSimpleScenario,
  PromptsGetWithArgsScenario,
  PromptsGetEmbeddedResourceScenario,
  PromptsGetWithImageScenario
} from './server/prompts';

import { DNSRebindingProtectionScenario } from './server/dns-rebinding';

import {
  HttpHeaderValidationScenario,
  HttpCustomHeaderServerValidationScenario
} from './server/http-standard-headers';

import {
  authScenariosList,
  backcompatScenariosList,
  draftScenariosList,
  extensionScenariosList
} from './client/auth/index';
import { listMetadataScenarios } from './client/auth/discovery-metadata';
import { AuthorizationServerMetadataEndpointScenario } from './authorization-server/authorization-server-metadata';

import { HttpStandardHeadersScenario } from './client/http-standard-headers';
import {
  HttpCustomHeadersScenario,
  HttpInvalidToolHeadersScenario
} from './client/http-custom-headers';

// Pending client scenarios (not yet fully tested/implemented)
const pendingClientScenariosList: ClientScenario[] = [
  // JSON Schema 2020-12 (SEP-1613)
  // This test is pending until the SDK includes PR #1135 which preserves
  // $schema, $defs, and additionalProperties fields in tool schemas.
  new JsonSchema2020_12Scenario(),

  // On hold until server-side SSE improvements are made
  // https://github.com/modelcontextprotocol/typescript-sdk/pull/1129
  new ServerSSEPollingScenario(),

  // HTTP Standardization (SEP-2243)
  // Pending until the everything-server fully implements SEP-2243
  // header validation (case-insensitive names, whitespace trimming, -32001 error code)
  new HttpHeaderValidationScenario(),
  new HttpCustomHeaderServerValidationScenario()
];

// All client scenarios
const allClientScenariosList: ClientScenario[] = [
  // Lifecycle scenarios
  new ServerInitializeScenario(),
  new ServerProtocolVersionHeaderScenario(),

  // Utilities scenarios
  new LoggingSetLevelScenario(),
  new PingScenario(),
  new CompletionCompleteScenario(),

  // Tools scenarios
  new ToolsListScenario(),
  new ToolsCallSimpleTextScenario(),
  new ToolsCallImageScenario(),
  new ToolsCallAudioScenario(),
  new ToolsCallEmbeddedResourceScenario(),
  new ToolsCallMultipleContentTypesScenario(),
  new ToolsCallWithLoggingScenario(),
  new ToolsCallErrorScenario(),
  new ToolsCallWithProgressScenario(),
  new ToolsCallSamplingScenario(),
  new ToolsCallElicitationScenario(),

  // JSON Schema 2020-12 support (SEP-1613)
  new JsonSchema2020_12Scenario(),

  // Elicitation scenarios (SEP-1034)
  new ElicitationDefaultsScenario(),

  // SSE Polling scenarios (SEP-1699)
  new ServerSSEPollingScenario(),
  new ServerSSEMultipleStreamsScenario(),

  // Elicitation scenarios (SEP-1330) - pending
  new ElicitationEnumsScenario(),

  // Resources scenarios
  new ResourcesListScenario(),
  new ResourcesReadTextScenario(),
  new ResourcesReadBinaryScenario(),
  new ResourcesTemplateReadScenario(),
  new ResourcesSubscribeScenario(),
  new ResourcesUnsubscribeScenario(),

  // Resources error handling (SEP-2164)
  new ResourcesNotFoundErrorScenario(),

  // Prompts scenarios
  new PromptsListScenario(),
  new PromptsGetSimpleScenario(),
  new PromptsGetWithArgsScenario(),
  new PromptsGetEmbeddedResourceScenario(),
  new PromptsGetWithImageScenario(),

  // Security scenarios
  new DNSRebindingProtectionScenario(),

  // HTTP Standardization scenarios (SEP-2243)
  new HttpHeaderValidationScenario(),
  new HttpCustomHeaderServerValidationScenario()
];

// Active client scenarios (excludes pending)
const activeClientScenariosList: ClientScenario[] =
  allClientScenariosList.filter(
    (scenario) =>
      !pendingClientScenariosList.some(
        (pending) => pending.name === scenario.name
      )
  );

// Client scenarios map - built from list
export const clientScenarios = new Map<string, ClientScenario>(
  allClientScenariosList.map((scenario) => [scenario.name, scenario])
);

// All client scenarios for authorization server
const allClientScenariosListForAuthorizationServer: ClientScenario[] = [
  // Authorization server scenarios
  new AuthorizationServerMetadataEndpointScenario()
];

// Client scenarios map for authorization server - built from list
export const clientScenariosForAuthorizationServer = new Map<
  string,
  ClientScenario
>(
  allClientScenariosListForAuthorizationServer.map((scenario) => [
    scenario.name,
    scenario
  ])
);

// All client test scenarios (core + backcompat + extensions)
const scenariosList: Scenario[] = [
  new InitializeScenario(),
  new ToolsCallScenario(),
  new ElicitationClientDefaultsScenario(),
  new SSERetryScenario(),
  new RequestMetadataScenario(),
  ...authScenariosList,
  ...backcompatScenariosList,
  ...draftScenariosList,
  ...extensionScenariosList,

  // HTTP Standardization scenarios (SEP-2243)
  new HttpStandardHeadersScenario(),
  new HttpCustomHeadersScenario(),
  new HttpInvalidToolHeadersScenario()
];

// Core scenarios (tier 1 requirements)
const coreScenariosList: Scenario[] = [
  new InitializeScenario(),
  new ToolsCallScenario(),
  new ElicitationClientDefaultsScenario(),
  new SSERetryScenario(),
  ...authScenariosList
];

// Scenarios map - built from list
export const scenarios = new Map<string, Scenario>(
  scenariosList.map((scenario) => [scenario.name, scenario])
);

export function registerScenario(name: string, scenario: Scenario): void {
  scenarios.set(name, scenario);
}

export function getScenario(name: string): Scenario | undefined {
  return scenarios.get(name);
}

export function getClientScenario(name: string): ClientScenario | undefined {
  return clientScenarios.get(name);
}

export function getClientScenarioForAuthorizationServer(
  name: string
): ClientScenarioForAuthorizationServer | undefined {
  return clientScenariosForAuthorizationServer.get(name);
}

export function listScenarios(): string[] {
  return Array.from(scenarios.keys());
}

export function listClientScenarios(): string[] {
  return Array.from(clientScenarios.keys());
}

export function listActiveClientScenarios(): string[] {
  return activeClientScenariosList.map((scenario) => scenario.name);
}

export function listPendingClientScenarios(): string[] {
  return pendingClientScenariosList.map((scenario) => scenario.name);
}

export function listAuthScenarios(): string[] {
  return authScenariosList.map((scenario) => scenario.name);
}

export function listCoreScenarios(): string[] {
  return coreScenariosList.map((scenario) => scenario.name);
}

export function listExtensionScenarios(): string[] {
  return extensionScenariosList.map((scenario) => scenario.name);
}

export function listBackcompatScenarios(): string[] {
  return backcompatScenariosList.map((scenario) => scenario.name);
}

export function listClientScenariosForAuthorizationServer(): string[] {
  return Array.from(clientScenariosForAuthorizationServer.keys());
}

export function listDraftScenarios(): string[] {
  return draftScenariosList.map((scenario) => scenario.name);
}

export { listMetadataScenarios };

// All valid spec versions, used by the CLI to validate --spec-version input.
// 'extension' is intentionally excluded — extension scenarios are off-timeline
// and selected via `--suite extensions`, not `--spec-version`.
export const ALL_SPEC_VERSIONS: SpecVersion[] = [
  ...DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
];

export function resolveSpecVersion(value: string): SpecVersion {
  if (value === 'draft') return DRAFT_PROTOCOL_VERSION;
  if (ALL_SPEC_VERSIONS.includes(value as SpecVersion)) {
    return value as SpecVersion;
  }
  console.error(`Unknown spec version: ${value}`);
  console.error(
    `Valid versions: ${ALL_SPEC_VERSIONS.join(', ')} (or 'draft' as an alias for ${DRAFT_PROTOCOL_VERSION})`
  );
  process.exit(1);
}

function versionIndex(
  v: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION
): number {
  return ALL_SPEC_VERSIONS.indexOf(v);
}

// Off-timeline sources (extensions etc.) are never selected by --spec-version.
function matchesSpecVersion(
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

export function listScenariosForSpec(version: SpecVersion): string[] {
  return scenariosList
    .filter((s) => matchesSpecVersion(s.source, version))
    .map((s) => s.name);
}

export function listClientScenariosForSpec(version: SpecVersion): string[] {
  return allClientScenariosList
    .filter((s) => matchesSpecVersion(s.source, version))
    .map((s) => s.name);
}

export function listClientScenariosForAuthorizationServerForSpec(
  version: SpecVersion
): string[] {
  return allClientScenariosListForAuthorizationServer
    .filter((s) => matchesSpecVersion(s.source, version))
    .map((s) => s.name);
}

export function getScenarioSpecVersions(
  name: string
): ScenarioSpecTag[] | undefined {
  const s =
    scenarios.get(name) ??
    clientScenarios.get(name) ??
    clientScenariosForAuthorizationServer.get(name);
  if (!s) return undefined;
  if ('extensionId' in s.source) return ['extension'];
  const result: ScenarioSpecTag[] = [];
  for (const v of ALL_SPEC_VERSIONS) {
    if (matchesSpecVersion(s.source, v)) result.push(v);
  }
  return result;
}

export type { SpecVersion, ScenarioSpecTag };
