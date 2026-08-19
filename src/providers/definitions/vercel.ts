import { capability } from '../capabilities.js';
import type { ProviderDefinition } from '../types.js';

export const vercelProvider: ProviderDefinition = {
  id: 'vercel', displayName: 'Vercel', adapterVersion: 1,
  credentialEnvironmentVariable: 'VERCEL_TOKEN',
  executables: {},
  identity: { operation: 'identity.verify', expectedFields: ['teamId'], maxAgeMs: 86_400_000 },
  recoveryCommand: 'inframux replace-token vercel',
  onboarding: {
    auth: 'static-token', setupUrl: 'https://vercel.com/account/tokens',
    documentationUrl: 'https://vercel.com/docs/rest-api', requiredConfig: ['teamId'],
    optionalConfig: ['user', 'projects'], credentialReuse: 'explicit',
  },
  capabilities: [
    capability('identity.verify', { surface: 'api' }),
    capability('api.request', { surface: 'api', destructive: true, idempotent: false }),
    capability('resources.list', { surface: 'api' }),
    capability('source.deploy', { surface: 'api', classification: 'source-bound', support: 'preview', dryRun: true }),
  ],
};
