import { Scenario, ClientScenario, SpecVersion } from '../types';
import { InitializeScenario } from './client/initialize';
import { ToolsCallScenario } from './client/tools_call';
import { ElicitationClientDefaultsScenario } from './client/elicitation-defaults';
import { SSERetryScenario } from './client/sse-retry';

// Import all new server test scenarios
import { ServerInitializeScenario } from './server/lifecycle';

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
  ResourcesUnsubscribeScenario
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
  authScenariosList,
  backcompatScenariosList,
  draftScenariosList,
  extensionScenariosList
} from './client/auth/index';
import { listMetadataScenarios } from './client/auth/discovery-metadata';

// Pending client scenarios (not yet fully tested/implemented)
const pendingClientScenariosList: ClientScenario[] = [
  // JSON Schema 2020-12 (SEP-1613)
  // This test is pending until the SDK includes PR #1135 which preserves
  // $schema, $defs, and additionalProperties fields in tool schemas.
  new JsonSchema2020_12Scenario(),

  // On hold until server-side SSE improvements are made
  // https://github.com/modelcontextprotocol/typescript-sdk/pull/1129
  new ServerSSEPollingScenario()
];

// All client scenarios
const allClientScenariosList: ClientScenario[] = [
  // Lifecycle scenarios
  new ServerInitializeScenario(),

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

  // Prompts scenarios
  new PromptsListScenario(),
  new PromptsGetSimpleScenario(),
  new PromptsGetWithArgsScenario(),
  new PromptsGetEmbeddedResourceScenario(),
  new PromptsGetWithImageScenario(),

  // Security scenarios
  new DNSRebindingProtectionScenario()
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

// All client test scenarios (core + backcompat + extensions)
const scenariosList: Scenario[] = [
  new InitializeScenario(),
  new ToolsCallScenario(),
  new ElicitationClientDefaultsScenario(),
  new SSERetryScenario(),
  ...authScenariosList,
  ...backcompatScenariosList,
  ...draftScenariosList,
  ...extensionScenariosList
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

export function listDraftScenarios(): string[] {
  return draftScenariosList.map((scenario) => scenario.name);
}

export { listMetadataScenarios };

// All valid spec versions, used by the CLI to validate --spec-version input.
export const ALL_SPEC_VERSIONS: SpecVersion[] = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  'draft',
  'extension'
];

export function listScenariosForSpec(version: SpecVersion): string[] {
  return scenariosList
    .filter((s) => s.specVersions.includes(version))
    .map((s) => s.name);
}

export function listClientScenariosForSpec(version: SpecVersion): string[] {
  return allClientScenariosList
    .filter((s) => s.specVersions.includes(version))
    .map((s) => s.name);
}

export function getScenarioSpecVersions(
  name: string
): SpecVersion[] | undefined {
  return (
    scenarios.get(name)?.specVersions ?? clientScenarios.get(name)?.specVersions
  );
}

export type { SpecVersion };
