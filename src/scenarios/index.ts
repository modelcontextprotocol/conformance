import { Scenario, ClientScenario } from '../types.js';
import { InitializeScenario } from './client/initialize.js';
import { ToolsCallScenario } from './client/tools_call.js';
import { ServerInitializeClientScenario } from './server/server_initialize.js';

// Import all new server test scenarios
import {
    ServerInitializeScenario,
    ServerInitializeCapabilitiesScenario
} from './server/lifecycle.js';

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

export const scenarios = new Map<string, Scenario>([
    ['initialize', new InitializeScenario()],
    ['tools-call', new ToolsCallScenario()]
]);

export const clientScenarios = new Map<string, ClientScenario>([
    // Legacy
    ['initialize', new ServerInitializeClientScenario()],

    // Lifecycle scenarios
    ['server-initialize', new ServerInitializeScenario()],
    ['server-initialize-capabilities', new ServerInitializeCapabilitiesScenario()],

    // Utilities scenarios
    ['logging-set-level', new LoggingSetLevelScenario()],
    ['completion-complete', new CompletionCompleteScenario()],

    // Tools scenarios
    ['tools-list', new ToolsListScenario()],
    ['tools-call-simple-text', new ToolsCallSimpleTextScenario()],
    ['tools-call-image', new ToolsCallImageScenario()],
    ['tools-call-audio', new ToolsCallAudioScenario()],
    ['tools-call-embedded-resource', new ToolsCallEmbeddedResourceScenario()],
    ['tools-call-mixed-content', new ToolsCallMultipleContentTypesScenario()],
    ['tools-call-with-logging', new ToolsCallWithLoggingScenario()],
    ['tools-call-error', new ToolsCallErrorScenario()],
    ['tools-call-with-progress', new ToolsCallWithProgressScenario()],
    ['tools-call-sampling', new ToolsCallSamplingScenario()],
    ['tools-call-elicitation', new ToolsCallElicitationScenario()],

    // Resources scenarios
    ['resources-list', new ResourcesListScenario()],
    ['resources-read-text', new ResourcesReadTextScenario()],
    ['resources-read-binary', new ResourcesReadBinaryScenario()],
    ['resources-templates-read', new ResourcesTemplateReadScenario()],
    ['resources-subscribe', new ResourcesSubscribeScenario()],
    ['resources-unsubscribe', new ResourcesUnsubscribeScenario()],

    // Prompts scenarios
    ['prompts-list', new PromptsListScenario()],
    ['prompts-get-simple', new PromptsGetSimpleScenario()],
    ['prompts-get-with-args', new PromptsGetWithArgsScenario()],
    ['prompts-get-embedded-resource', new PromptsGetEmbeddedResourceScenario()],
    ['prompts-get-with-image', new PromptsGetWithImageScenario()]
]);

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
