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
  ScopeStepUpAuthScenario,
  ScopeRetryLimitScenario
} from './scope-handling';
import {
  ClientSecretBasicAuthScenario,
  ClientSecretPostAuthScenario,
  PublicClientAuthScenario
} from './token-endpoint-auth';
import {
  ClientCredentialsJwtScenario,
  ClientCredentialsBasicScenario
} from './client-credentials';
import { ResourceMismatchScenario } from './resource-mismatch';
import { PreRegistrationScenario } from './pre-registration';
import {
  TokenRefreshBasicScenario,
  TokenRefreshRotationScenario
} from './token-refresh';

// Auth scenarios (required for tier 1)
export const authScenariosList: Scenario[] = [
  ...metadataScenarios,
  new AuthBasicCIMDScenario(),
  new ScopeFromWwwAuthenticateScenario(),
  new ScopeFromScopesSupportedScenario(),
  new ScopeOmittedWhenUndefinedScenario(),
  new ScopeStepUpAuthScenario(),
  new ScopeRetryLimitScenario(),
  new ClientSecretBasicAuthScenario(),
  new ClientSecretPostAuthScenario(),
  new PublicClientAuthScenario(),
  new ResourceMismatchScenario(),
  new PreRegistrationScenario(),
  new TokenRefreshBasicScenario(),
  new TokenRefreshRotationScenario()
];

// Back-compat scenarios (optional - backward compatibility with older spec versions)
export const backcompatScenariosList: Scenario[] = [
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario()
];

// Extension scenarios (optional for tier 1 - protocol extensions)
export const extensionScenariosList: Scenario[] = [
  new ClientCredentialsJwtScenario(),
  new ClientCredentialsBasicScenario()
];
