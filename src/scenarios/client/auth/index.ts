import { Scenario } from '../../../types';
import { metadataScenarios } from './discovery-metadata.js';
import {
  Auth20250326OAuthMetadataBackcompatScenario,
  Auth20250326OEndpointFallbackScenario
} from './march-spec-backcompat.js';
import {
  ScopeFromWwwAuthenticateScenario,
  ScopeFromScopesSupportedScenario,
  ScopeOmittedWhenUndefinedScenario,
  ScopeStepUpAuthScenario
} from './scope-handling.js';

export const authScenariosList: Scenario[] = [
  ...metadataScenarios,
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario(),
  new ScopeFromWwwAuthenticateScenario(),
  new ScopeFromScopesSupportedScenario(),
  new ScopeOmittedWhenUndefinedScenario(),
  new ScopeStepUpAuthScenario()
];
