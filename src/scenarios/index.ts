import { Scenario, ClientScenario } from '../types.js';
import { InitializeScenario } from './client/initialize.js';
import { ToolsCallScenario } from './client/tools_call.js';
import { ServerInitializeClientScenario } from './server/server_initialize.js';

export const scenarios = new Map<string, Scenario>([
    ['initialize', new InitializeScenario()],
    ['tools-call', new ToolsCallScenario()]
]);

export const clientScenarios = new Map<string, ClientScenario>([
    ['server-initialize', new ServerInitializeClientScenario()]
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
