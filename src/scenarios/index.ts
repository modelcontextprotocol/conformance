import { Scenario, ClientScenario } from '../types';
import { InitializeScenario } from './client/initialize';
import { ToolsCallScenario } from './client/tools_call';
import { ElicitationClientDefaultsScenario } from './client/elicitation-defaults';

// Import all new server test scenarios
import { ServerInitializeScenario } from './server/lifecycle';

import {
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

import { ElicitationDefaultsScenario } from './server/elicitation-defaults';
import { ElicitationEnumsScenario } from './server/elicitation-enums';

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

import { authScenariosList } from './client/auth/index';

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
  new ElicitationClientDefaultsScenario(),
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
