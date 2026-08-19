import { cloudflareProvider } from './definitions/cloudflare.js';
import { googleCloudProvider, posthogProvider, resendProvider, sentryProvider, syntheticProvider, uptimeRobotProvider } from './definitions/others.js';
import { supabaseProvider } from './definitions/supabase.js';
import { vercelProvider } from './definitions/vercel.js';
import type { ProviderDefinition } from './types.js';

export class ProviderRegistry {
  readonly #providers: ReadonlyMap<string, ProviderDefinition>;

  constructor(providers: readonly ProviderDefinition[]) {
    const entries = providers.map((provider) => [provider.id, deepFreezeProvider(provider)] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('Duplicate provider ID');
    this.#providers = new Map(entries);
  }

  list(): readonly ProviderDefinition[] {
    return Object.freeze([...this.#providers.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }

  require(id: string): ProviderDefinition {
    const provider = this.#providers.get(id);
    if (provider === undefined) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  completionCandidates(): readonly string[] {
    return Object.freeze(this.list().flatMap((provider) =>
      provider.capabilities.map((capability) => `${provider.id}:${capability.operation}`),
    ).sort());
  }
}

export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    cloudflareProvider,
    googleCloudProvider,
    posthogProvider,
    resendProvider,
    sentryProvider,
    supabaseProvider,
    syntheticProvider,
    uptimeRobotProvider,
    vercelProvider,
  ]);
}

function deepFreezeProvider(provider: ProviderDefinition): ProviderDefinition {
  for (const capability of provider.capabilities) {
    Object.freeze(capability.requiredScopes);
    Object.freeze(capability);
  }
  Object.freeze(provider.capabilities);
  Object.freeze(provider.identity.expectedFields);
  Object.freeze(provider.identity);
  Object.freeze(provider.onboarding.requiredConfig);
  Object.freeze(provider.onboarding.optionalConfig);
  Object.freeze(provider.onboarding);
  Object.freeze(provider.executables);
  if (provider.commandPolicy !== undefined) {
    Object.freeze(provider.commandPolicy.allowedTopLevel);
    Object.freeze(provider.commandPolicy.blockedFlags);
    Object.freeze(provider.commandPolicy);
  }
  return Object.freeze(provider);
}
