import { Scenario } from '../types.js';
import { InitializeScenario } from './initialize.js';

export const scenarios = new Map<string, Scenario>([['initialize', new InitializeScenario()]]);

export function registerScenario(name: string, scenario: Scenario): void {
    scenarios.set(name, scenario);
}

export function getScenario(name: string): Scenario | undefined {
    return scenarios.get(name);
}

export function listScenarios(): string[] {
    return Array.from(scenarios.keys());
}
