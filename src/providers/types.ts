export type ProviderSurface = 'api' | 'cli' | 'official-mcp' | 'browser';
export type OperationClassification = 'control-plane' | 'source-bound';
export type CapabilitySupport = 'stable' | 'preview' | 'unsupported';

export interface Capability {
  readonly operation: string;
  readonly surface: ProviderSurface;
  readonly classification: OperationClassification;
  readonly support: CapabilitySupport;
  readonly identityCheck: boolean;
  readonly requiredScopes: readonly string[];
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly dryRun: boolean;
}

export interface ProviderIdentityContract {
  readonly operation: string;
  readonly expectedFields: readonly string[];
  readonly maxAgeMs: number;
  readonly deriveExpected?: (service: Readonly<Record<string, unknown>>) => Readonly<Record<string, string>>;
}

export interface ProviderExecutableIds {
  readonly cli?: string;
  readonly mcp?: string;
}

export interface ProviderCommandPolicy {
  readonly allowedTopLevel: readonly string[];
  readonly blockedFlags: readonly string[];
}

export interface ProviderOnboarding {
  readonly auth: 'static-token' | 'oauth-pkce';
  readonly setupUrl: string;
  readonly documentationUrl: string;
  readonly requiredConfig: readonly string[];
  readonly optionalConfig: readonly string[];
  readonly credentialReuse: 'explicit';
}

export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion: number;
  readonly credentialEnvironmentVariable?: string;
  readonly executables: ProviderExecutableIds;
  readonly identity: ProviderIdentityContract;
  readonly recoveryCommand: string;
  readonly onboarding: ProviderOnboarding;
  readonly capabilities: readonly Capability[];
  readonly commandPolicy?: ProviderCommandPolicy;
}
