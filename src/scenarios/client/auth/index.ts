import { Scenario } from '../../../types';
import { AuthBasicDCRScenario } from './basic-dcr.js';
import { AuthBasicCIMDScenario } from './basic-cimd.js';
import {
  AuthBasicMetadataVar1Scenario,
  AuthBasicMetadataVar2Scenario,
  AuthBasicMetadataVar3Scenario
} from './basic-metadata.js';
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
