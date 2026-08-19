import { capability } from '../capabilities.js';
import type { ProviderDefinition } from '../types.js';

export const cloudflareProvider: ProviderDefinition = {
  id: 'cloudflare', displayName: 'Cloudflare', adapterVersion: 1,
  credentialEnvironmentVariable: 'CLOUDFLARE_API_TOKEN',
  executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['accountId'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token cloudflare',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    documentationUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/',
    requiredConfig: ['accountId'], optionalConfig: ['zones', 'resources'], credentialReuse: 'explicit',
  },
  capabilities: [
    capability('identity.verify', { surface: 'api' }),
    capability('resources.list', { surface: 'api' }),
    capability('api.request', { surface: 'api', destructive: true, idempotent: false }),
    capability('source.deploy', { surface: 'api', classification: 'source-bound', support: 'preview', dryRun: true }),
  ],
};
