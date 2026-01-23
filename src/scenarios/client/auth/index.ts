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

// Auth scenarios (required for tier 1)
export const authScenariosList: Scenario[] = [
  ...metadataScenarios,
  new AuthBasicCIMDScenario(),
  new Auth20250326OAuthMetadataBackcompatScenario(),
  new Auth20250326OEndpointFallbackScenario(),
  new ScopeFromWwwAuthenticateScenario(),
  new ScopeFromScopesSupportedScenario(),
  new ScopeOmittedWhenUndefinedScenario(),
  new ScopeStepUpAuthScenario(),
  new ScopeRetryLimitScenario(),
  new ClientSecretBasicAuthScenario(),
  new ClientSecretPostAuthScenario(),
  new PublicClientAuthScenario(),
  new ResourceMismatchScenario()
];

// Extension scenarios (optional for tier 1 - protocol extensions)
export const extensionScenariosList: Scenario[] = [
  new ClientCredentialsJwtScenario(),
  new ClientCredentialsBasicScenario()
];
