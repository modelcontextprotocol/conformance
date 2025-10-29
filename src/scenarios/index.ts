import { Scenario } from '../types.js';

export const scenarios = new Map<string, Scenario>();

export function registerScenario(name: string, scenario: Scenario): void {
  scenarios.set(name, scenario);
}

export function getScenario(name: string): Scenario | undefined {
  return scenarios.get(name);
}

export function listScenarios(): string[] {
  return Array.from(scenarios.keys());
}
