import {
  AuthHandlerScenario,
  type AuxOriginRole,
  type Scenario,
  type ScenarioSource
} from '../types';
import type { Step } from '../steps';

/**
 * What the hosted matrix needs to know about a client scenario, as plain
 * data: enough to list its cells, score them and say whether this
 * deployment can start them, without loading the scenario (./catalog.ts).
 */
export interface ScenarioMeta {
  name: string;
  description: string;
  source: ScenarioSource;
  /** The scenario's own mcpPath, when it sets one. */
  mcpPath?: string;
  steps?: readonly Step[];
  /** The relay roles of a scenario served through authHandlers(). */
  auxRoles?: readonly AuxOriginRole[];
  /** Whether the hosted server can mount it: handler() or authHandlers(). */
  hostable: boolean;
  allowClientError?: boolean;
}

export function scenarioMeta(scenario: Scenario): ScenarioMeta {
  const auth = scenario instanceof AuthHandlerScenario;
  return {
    name: scenario.name,
    description: scenario.description,
    source: scenario.source,
    ...(scenario.mcpPath !== undefined && { mcpPath: scenario.mcpPath }),
    ...(scenario.steps && { steps: scenario.steps }),
    ...(auth && { auxRoles: scenario.auxRoles }),
    hostable: auth || typeof scenario.handler === 'function',
    ...(scenario.allowClientError !== undefined && {
      allowClientError: scenario.allowClientError
    })
  };
}
