import type { HttpTransport } from '../http-transport.js';
import { cloudflareAdapter } from './cloudflare.js';
import { googleAdapter } from './google.js';
import { posthogAdapter } from './posthog.js';
import { resendAdapter } from './resend.js';
import { sentryAdapter } from './sentry.js';
import { supabaseAdapter } from './supabase.js';
import type { ProviderAdapter } from './types.js';
import { uptimeRobotAdapter } from './uptimerobot.js';
import { vercelAdapter } from './vercel.js';

export class ProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[]) {
    if (new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length) throw new Error('Duplicate provider adapter ID');
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, Object.freeze(adapter)]));
  }

  require(id: string): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) throw new Error(`No production adapter is registered for provider: ${id}`);
    return adapter;
  }

  list(): readonly ProviderAdapter[] {
    return Object.freeze([...this.#adapters.values()].sort((left, right) => left.id.localeCompare(right.id)));
  }
}

export function createProviderAdapterRegistry(options: {
  transport: HttpTransport;
  originOverrides?: Readonly<Record<string, string>>;
  googleEndpointOverrides?: Readonly<Record<string, { readonly origin: string; readonly prefix?: string; readonly path?: string }>>;
}): ProviderAdapterRegistry {
  const origin = (provider: string, fallback: string) => options.originOverrides?.[provider] ?? fallback;
  return new ProviderAdapterRegistry([
    cloudflareAdapter(options.transport, origin('cloudflare', 'https://api.cloudflare.com')),
    googleAdapter(options.transport, options.googleEndpointOverrides),
    posthogAdapter(options.transport, options.originOverrides?.posthog),
    resendAdapter(options.transport, origin('resend', 'https://api.resend.com')),
    sentryAdapter(options.transport, options.originOverrides?.sentry),
    supabaseAdapter(options.transport, origin('supabase', 'https://api.supabase.com')),
    uptimeRobotAdapter(options.transport, origin('uptimerobot', 'https://api.uptimerobot.com')),
    vercelAdapter(options.transport, origin('vercel', 'https://api.vercel.com')),
  ]);
}

export type { ProviderAdapter, ProviderAdapterContext, ProviderCallContext, VerifiedProvider } from './types.js';
