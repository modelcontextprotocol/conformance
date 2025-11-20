import { Scenario } from '../../../types';
import { AuthBasicDCRScenario } from './basic-dcr';
import { AuthBasicCIMDScenario } from './basic-cimd';
import {
  AuthBasicMetadataVar1Scenario,
  AuthBasicMetadataVar2Scenario,
  AuthBasicMetadataVar3Scenario
} from './basic-metadata';
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
  new AuthBasicDCRScenario(),
  new AuthBasicCIMDScenario(),
  new AuthBasicMetadataVar1Scenario(),
  new AuthBasicMetadataVar2Scenario(),
  new AuthBasicMetadataVar3Scenario(),
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario(),
  new ScopeFromWwwAuthenticateScenario(),
  new ScopeFromScopesSupportedScenario(),
  new ScopeOmittedWhenUndefinedScenario(),
  new ScopeStepUpAuthScenario()
];
