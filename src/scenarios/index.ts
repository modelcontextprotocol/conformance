import { Scenario, ClientScenario } from '../types.js';
import { InitializeScenario } from './client/initialize.js';
import { ToolsCallScenario } from './client/tools_call.js';
import { ElicitationClientDefaultsScenario } from './client/elicitation-defaults.js';
import { SSERetryScenario } from './client/sse-retry.js';

// Import all new server test scenarios
import { ServerInitializeScenario } from './server/lifecycle.js';

import {
  LoggingSetLevelScenario,
  CompletionCompleteScenario
} from './server/utils.js';

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
} from './server/tools.js';

import { JsonSchema2020_12Scenario } from './server/json-schema-2020-12.js';

import { ElicitationDefaultsScenario } from './server/elicitation-defaults.js';
import { ElicitationEnumsScenario } from './server/elicitation-enums.js';
import { ServerSSEPollingScenario } from './server/sse-polling.js';
import { ServerSSEMultipleStreamsScenario } from './server/sse-multiple-streams.js';

import {
  ResourcesListScenario,
  ResourcesReadTextScenario,
  ResourcesReadBinaryScenario,
  ResourcesTemplateReadScenario,
  ResourcesSubscribeScenario,
  ResourcesUnsubscribeScenario
} from './server/resources.js';

import {
  PromptsListScenario,
  PromptsGetSimpleScenario,
  PromptsGetWithArgsScenario,
  PromptsGetEmbeddedResourceScenario,
  PromptsGetWithImageScenario
} from './server/prompts.js';

import { authScenariosList } from './client/auth/index.js';
import { listMetadataScenarios } from './client/auth/discovery-metadata.js';

// Pending client scenarios (not yet fully tested/implemented)
const pendingClientScenariosList: ClientScenario[] = [
  // Elicitation scenarios (SEP-1330)
  new ElicitationEnumsScenario(),

  // JSON Schema 2020-12 (SEP-1613)
  // This test is pending until the SDK includes PR #1135 which preserves
  // $schema, $defs, and additionalProperties fields in tool schemas.
  new JsonSchema2020_12Scenario()
];

// All client scenarios
const allClientScenariosList: ClientScenario[] = [
  // Lifecycle scenarios
  new ServerInitializeScenario(),

  // Utilities scenarios
  new LoggingSetLevelScenario(),
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
  ...pendingClientScenariosList,

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
  new PromptsGetWithImageScenario()
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

// Scenario scenarios
const scenariosList: Scenario[] = [
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

export function listAuthScenarios(): string[] {
  return authScenariosList.map((scenario) => scenario.name);
}

export { listMetadataScenarios };
