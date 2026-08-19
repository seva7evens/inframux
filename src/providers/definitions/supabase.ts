import { capability } from '../capabilities.js';
import type { ProviderDefinition } from '../types.js';

export const supabaseProvider: ProviderDefinition = {
  id: 'supabase', displayName: 'Supabase', adapterVersion: 1,
  credentialEnvironmentVariable: 'SUPABASE_ACCESS_TOKEN',
  executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['organizationId'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token supabase',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://supabase.com/dashboard/account/tokens',
    documentationUrl: 'https://supabase.com/docs/reference/api/introduction',
    requiredConfig: ['organizationId'], optionalConfig: ['projects'], credentialReuse: 'explicit',
  },
  capabilities: [
    capability('identity.verify', { surface: 'api' }),
    capability('api.request', { surface: 'api', destructive: true, idempotent: false }),
    capability('resources.list', { surface: 'api' }),
    capability('database.migrate', { surface: 'cli', classification: 'source-bound', support: 'unsupported', destructive: true, idempotent: false }),
  ],
};
