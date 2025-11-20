import { Scenario } from '../../../types';
import { metadataScenarios } from './discovery-metadata';
import { AuthBasicCIMDScenario } from './basic-cimd';
import {
  Auth20250326OAuthMetadataBackcompatScenario,
  Auth20250326OEndpointFallbackScenario
} from './march-spec-backcompat';
import {
  ScopeFromWwwAuthenticateScenario,
  ScopeFromScopesSupportedScenario,
  ScopeOmittedWhenUndefinedScenario,
  ScopeStepUpAuthScenario
} from './scope-handling';

export const authScenariosList: Scenario[] = [
  ...metadataScenarios,
  new AuthBasicCIMDScenario(),
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario(),
  new ScopeFromWwwAuthenticateScenario(),
  new ScopeFromScopesSupportedScenario(),
  new ScopeOmittedWhenUndefinedScenario(),
  new ScopeStepUpAuthScenario()
];
