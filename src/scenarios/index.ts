import { Scenario, ClientScenario } from '../types.js';
import { InitializeScenario } from './client/initialize.js';
import { ToolsCallScenario } from './client/tools_call.js';
import { AuthBasicDCRScenario } from './client/auth/basic-dcr.js';
import {
  AuthBasicMetadataVar1Scenario,
  AuthBasicMetadataVar2Scenario
} from './client/auth/basic-metadata.js';
import {
  Auth20250326OAuthMetadataBackcompatScenario,
  Auth20250326OEndpointFallbackScenario
} from './client/auth/march-spec-backcompat.js';
import { ElicitationClientDefaultsScenario } from './client/elicitation-defaults.js';

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

import { ElicitationDefaultsScenario } from './server/elicitation-defaults.js';
import { ElicitationEnumsScenario } from './server/elicitation-enums.js';

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

// Pending client scenarios (not yet fully tested/implemented)
const pendingClientScenariosList: ClientScenario[] = [
  // Elicitation scenarios (SEP-1330)
  new ElicitationEnumsScenario()
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

  // Elicitation scenarios (SEP-1034)
  new ElicitationDefaultsScenario(),

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
  new AuthBasicDCRScenario(),
  new AuthBasicMetadataVar1Scenario(),
  new AuthBasicMetadataVar2Scenario(),
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario(),
  new ElicitationClientDefaultsScenario()
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
